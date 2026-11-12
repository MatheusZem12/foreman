package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Connection test: being installed and "logged in" says nothing about the plan (a Codex
// whose ChatGPT plan ended still says "Logged in"). So each runtime, and each model in
// its catalog, gets a real call with the smallest prompt there is ("reply OK"): read-only,
// no tools, from an empty temporary folder. What answers works with this account; what
// doesn't is marked, with the CLI's own reason, and leaves the model picker.
//
// The results are kept in the database (they cost a little of the plan), redone once a
// day and whenever someone asks (the "Test" buttons).

const (
	probeKey     = "runtime_probes"
	probeTTL     = 24 * time.Hour
	probeTimeout = 2 * time.Minute
	probePrompt  = "Reply with exactly one word: OK"
)

// Probe is one test: a runtime with a model ("" = the CLI's default model).
type Probe struct {
	Runtime string `json:"runtime"`
	Model   string `json:"model"`
	OK      bool   `json:"ok"`
	Error   string `json:"error,omitempty"`
	// Busy: the model exists for this account but was overloaded or rate-limited at the
	// time (503, 429, "high demand"): it stays selectable, with a warning.
	Busy  bool      `json:"busy,omitempty"`
	Reply string    `json:"reply,omitempty"`
	Ms    int64     `json:"ms"`
	At    time.Time `json:"at"`
}

type probeState struct {
	mu       sync.Mutex
	loaded   bool
	results  map[string]Probe // runtime|model
	checking map[string]bool  // runtime → a test round is running
}

func probeID(runtime, model string) string { return runtime + "|" + model }

func (r *Runner) probesLoad(ctx context.Context) {
	r.probes.mu.Lock()
	defer r.probes.mu.Unlock()
	if r.probes.loaded {
		return
	}
	r.probes.loaded = true
	r.probes.results = map[string]Probe{}
	r.probes.checking = map[string]bool{}
	if err := r.st.GetSetting(ctx, probeKey, &r.probes.results); err != nil {
		log.Printf("probes: %v", err)
	}
	if r.probes.results == nil {
		r.probes.results = map[string]Probe{}
	}
}

// probeResult is the last test of a runtime and model, if there is one.
func (r *Runner) probeResult(runtime, model string) (Probe, bool) {
	r.probes.mu.Lock()
	defer r.probes.mu.Unlock()
	p, ok := r.probes.results[probeID(runtime, model)]
	return p, ok
}

func (r *Runner) probeChecking(runtime string) bool {
	r.probes.mu.Lock()
	defer r.probes.mu.Unlock()
	return r.probes.checking[runtime]
}

func (r *Runner) probeSave(ctx context.Context, ps ...Probe) {
	r.probes.mu.Lock()
	for _, p := range ps {
		r.probes.results[probeID(p.Runtime, p.Model)] = p
	}
	snapshot := make(map[string]Probe, len(r.probes.results))
	for k, v := range r.probes.results {
		snapshot[k] = v
	}
	r.probes.mu.Unlock()
	if err := r.st.SetSetting(ctx, probeKey, snapshot); err != nil {
		log.Printf("probes: save: %v", err)
	}
}

// ProbeAgent tests one runtime and model right now (the agent's "Test" button).
func (r *Runner) ProbeAgent(ctx context.Context, runtime, model string) Probe {
	r.probesLoad(ctx)
	p := r.probe(ctx, runtime, model)
	r.probeSave(context.Background(), p)
	return p
}

// CheckAll starts a test round of every runtime in the background (force: even if the
// last one is recent). It returns at once; the catalog says "checking" meanwhile.
func (r *Runner) CheckAll(force bool) {
	ctx := context.Background()
	r.probesLoad(ctx)
	for _, rt := range []string{"claude", "codex", "gemini"} {
		if !force && !r.probeStale(rt) {
			continue
		}
		r.probes.mu.Lock()
		busy := r.probes.checking[rt]
		r.probes.checking[rt] = true
		r.probes.mu.Unlock()
		if busy {
			continue
		}
		go func(rt string) {
			defer func() {
				r.probes.mu.Lock()
				delete(r.probes.checking, rt)
				r.probes.mu.Unlock()
				r.models.mu.Lock()
				r.models.at = time.Time{} // the next catalog read picks up the results
				r.models.mu.Unlock()
			}()
			r.checkRuntime(ctx, rt)
		}(rt)
	}
}

func (r *Runner) probeStale(runtime string) bool {
	p, ok := r.probeResult(runtime, "")
	return !ok || time.Since(p.At) > probeTTL
}

// checkRuntime tests the CLI's default model and then every model of the catalog, one by
// one: the default may fail only because of the model set in the CLI's own config, while
// others work (and the other way round). Only a CLI that isn't installed skips the rest.
func (r *Runner) checkRuntime(ctx context.Context, runtime string) {
	base := r.probe(ctx, runtime, "")
	r.probeSave(ctx, base)
	if strings.HasSuffix(base.Error, "isn't installed on the server") {
		return
	}
	var models []ModelOption
	for _, c := range r.Models(ctx, false) {
		if c.Runtime == runtime {
			models = c.Models
		}
	}
	// A few at a time: each answer takes seconds, and the screen fills in as they arrive.
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for _, m := range models {
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer func() { <-sem; wg.Done() }()
			r.probeSave(ctx, r.probe(ctx, runtime, id))
		}(m.ID)
	}
	wg.Wait()
}

// RuntimeWorks: the runtime answered with this account, with its default model or with
// any model of the catalog.
func (r *Runner) RuntimeWorks(runtime string, models []ModelOption) (bool, bool) {
	r.probes.mu.Lock()
	defer r.probes.mu.Unlock()
	base, tested := r.probes.results[probeID(runtime, "")]
	if base.OK {
		return true, true
	}
	for _, m := range models {
		if p, ok := r.probes.results[probeID(runtime, m.ID)]; ok {
			tested = true
			if p.OK {
				return true, true
			}
		}
	}
	return false, tested
}

func (r *Runner) probeCommand(runtime, model, dir string) (string, []string) {
	switch runtime {
	case "codex":
		args := []string{"exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", dir}
		if model != "" {
			args = append(args, "-m", model)
		}
		return r.cfg.CodexBin, append(args, probePrompt)
	case "gemini":
		args := []string{"-p", probePrompt, "-o", "json", "--approval-mode", "plan", "--skip-trust"}
		if model != "" {
			args = append(args, "-m", model)
		}
		return r.cfg.GeminiBin, args
	default:
		args := []string{"-p", probePrompt, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"}
		if model != "" {
			args = append(args, "--model", model)
		}
		return r.cfg.ClaudeBin, args
	}
}

func (r *Runner) probe(ctx context.Context, runtime, model string) Probe {
	start := time.Now()
	p := Probe{Runtime: runtime, Model: model, At: start}
	dir, err := os.MkdirTemp("", "foreman-probe-")
	if err != nil {
		p.Error = err.Error()
		return p
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	bin, args := r.probeCommand(runtime, model, dir)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = agentEnv(r.cacheEnv()...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	p.Ms = time.Since(start).Milliseconds()

	var reply, problem string
	switch runtime {
	case "codex":
		reply, problem = parseCodexProbe(out.Bytes())
	case "gemini":
		reply, problem = parseGeminiProbe(out.Bytes())
		if problem == "" && reply == "" {
			_, problem = parseGeminiProbe(errb.Bytes()) // its errors may come on stderr
		}
	default:
		reply, problem = parseClaudeProbe(out.Bytes())
	}
	if problem == "" && reply == "" {
		problem = jsonMessage(errb.String() + "\n" + out.String())
	}
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		// The CLIs retry by themselves on quota or capacity errors: say what they last saw.
		p.Error = "no answer in 2 minutes"
		if why := firstNonEmpty(problem, probeLastLine(errb.String())); why != "" && why != "}" {
			p.Error += ": " + why
		} else {
			p.Error += " (usually the account's quota or the model's capacity)"
		}
	case errors.Is(runErr, exec.ErrNotFound):
		p.Error = runtime + " isn't installed on the server"
	case problem != "":
		p.Error = problem
	case runErr != nil || strings.TrimSpace(reply) == "":
		p.Error = firstNonEmpty(probeLastLine(errb.String()), probeLastLine(out.String()), errText(runErr), "no answer")
	default:
		p.OK, p.Reply = true, clip(strings.TrimSpace(reply), 80)
	}
	p.Error = clip(cleanErr(p.Error), 300)
	p.Busy = !p.OK && busy(p.Error)
	return p
}

var reMessage = regexp.MustCompile(`"message"\s*:\s*"((?:[^"\\]|\\.)*)"`)

// jsonMessage takes the last "message" of an error the CLI printed as JSON (one or many
// lines), for when it isn't in the expected format.
func jsonMessage(s string) string {
	all := reMessage.FindAllStringSubmatch(s, -1)
	for i := len(all) - 1; i >= 0; i-- {
		var msg string
		if json.Unmarshal([]byte(`"`+all[i][1]+`"`), &msg) != nil {
			msg = all[i][1]
		}
		if strings.TrimSpace(msg) != "" {
			return msg
		}
	}
	return ""
}

var reBusy = regexp.MustCompile(`(?i)\b(503|429|529)\b|high demand|overloaded|rate.?limit|resource.?exhausted|try again later|temporarily|capacity`)

// busy: an error that says "not now" rather than "not for you".
func busy(err string) bool {
	return reBusy.MatchString(err) && !strings.Contains(strings.ToLower(err), "not supported")
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

func cleanErr(s string) string {
	return strings.TrimSpace(spaces.ReplaceAllString(ansi.ReplaceAllString(s, ""), " "))
}

func probeLastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(ansi.ReplaceAllString(s, "")), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}

func parseClaudeProbe(b []byte) (reply, problem string) {
	var v struct {
		Result  string `json:"result"`
		IsError bool   `json:"is_error"`
		Subtype string `json:"subtype"`
	}
	if json.Unmarshal(bytes.TrimSpace(b), &v) != nil {
		return "", ""
	}
	if v.IsError {
		return "", firstNonEmpty(v.Result, v.Subtype, "Claude Code returned an error")
	}
	return v.Result, ""
}

func parseCodexProbe(b []byte) (reply, problem string) {
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		for _, e := range normalizeCodex(line) {
			switch e.Kind {
			case "text":
				reply = e.Body
			case "error":
				problem = e.Body
			}
		}
	}
	if reply != "" {
		problem = "" // a retry warning on the way doesn't matter if it answered
	}
	return reply, problem
}

func parseGeminiProbe(b []byte) (reply, problem string) {
	var v struct {
		Response string `json:"response"`
		Error    *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	// Gemini may print notices before the JSON: read from the first "{".
	if i := bytes.IndexByte(b, '{'); i >= 0 {
		b = b[i:]
	}
	if json.Unmarshal(b, &v) != nil {
		return "", ""
	}
	if v.Error != nil && v.Error.Message != "" {
		return "", v.Error.Message
	}
	return v.Response, ""
}
