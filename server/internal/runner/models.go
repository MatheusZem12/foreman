package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Model catalog: built from the CLIs themselves, so the agent form only offers what
// exists and keeps up with releases without anyone typing anything.
//
//   - Codex: `codex debug models` returns the official catalog (Codex itself keeps it
//     up to date); without network, it falls back to its cache (~/.codex/models_cache.json).
//   - Gemini: `gemini models -o json` (the models the signed-in account can use).
//   - Claude: the aliases (opus, sonnet…) from `claude --help`, as `/model` offers them;
//     each always points to the newest version.
//
// Then every model is tested with the server's account (probe.go) and the screen offers
// only the ones that answered: what the plan really has.

type ModelOption struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Description   string   `json:"description,omitempty"`
	Group         string   `json:"group"` // alias | model | used
	Efforts       []string `json:"efforts,omitempty"`
	DefaultEffort string   `json:"defaultEffort,omitempty"`
	// The connection test with this account (probe.go): nil = not tested yet.
	Available *bool      `json:"available,omitempty"`
	Busy      bool       `json:"busy,omitempty"` // overloaded at the time of the test: still selectable
	Problem   string     `json:"problem,omitempty"`
	CheckedAt *time.Time `json:"checkedAt,omitempty"`
}

type RuntimeModels struct {
	Runtime   string        `json:"runtime"`
	Installed bool          `json:"installed"`
	Models    []ModelOption `json:"models"`
	Efforts   []string      `json:"efforts"` // levels the CLI accepts
	Source    string        `json:"source"`
	FetchedAt time.Time     `json:"fetchedAt"`
	Error     string        `json:"error,omitempty"`
	// The runtime's connection test (its default model): nil = not tested yet.
	Connected  *bool      `json:"connected,omitempty"`
	CheckError string     `json:"checkError,omitempty"`
	CheckedAt  *time.Time `json:"checkedAt,omitempty"`
	Checking   bool       `json:"checking"`
	// The CLI's default model (agents with no model chosen use it).
	DefaultOK    *bool  `json:"defaultOk,omitempty"`
	DefaultError string `json:"defaultError,omitempty"`
}

const modelsTTL = 6 * time.Hour

type modelCache struct {
	mu   sync.Mutex
	data []RuntimeModels
	at   time.Time
}

// Models returns the cached catalog, with each runtime's and model's connection test;
// force queries the CLIs again.
func (r *Runner) Models(ctx context.Context, force bool) []RuntimeModels {
	r.models.mu.Lock()
	if force || r.models.data == nil || time.Since(r.models.at) >= modelsTTL || r.models.at.IsZero() {
		r.models.data = []RuntimeModels{r.claudeModels(ctx), r.codexModels(ctx), r.geminiModels(ctx)}
		r.models.at = time.Now()
	}
	data := r.models.data
	r.models.mu.Unlock()
	r.probesLoad(ctx)
	return r.withProbes(data)
}

// withProbes copies the catalog adding the test results (the cache stays untouched).
func (r *Runner) withProbes(data []RuntimeModels) []RuntimeModels {
	out := make([]RuntimeModels, len(data))
	for i, rt := range data {
		rt.Models = append([]ModelOption(nil), rt.Models...)
		rt.Checking = r.probeChecking(rt.Runtime)
		if p, ok := r.probeResult(rt.Runtime, ""); ok {
			works, _ := r.RuntimeWorks(rt.Runtime, rt.Models)
			at, def := p.At, p.OK
			rt.Connected, rt.CheckedAt, rt.DefaultOK, rt.DefaultError = &works, &at, &def, p.Error
			if !works {
				rt.CheckError = p.Error
			}
		}
		for j, m := range rt.Models {
			if p, ok := r.probeResult(rt.Runtime, m.ID); ok {
				at := p.At
				m.Problem, m.CheckedAt, m.Busy = p.Error, &at, p.Busy || (!p.OK && busy(p.Error))
				if !m.Busy { // a busy model isn't known to be unavailable
					ok := p.OK
					m.Available = &ok
				}
				rt.Models[j] = m
			}
		}
		out[i] = rt
	}
	return out
}

// Refreshes the catalog on start and periodically, in the background.
func (r *Runner) refreshModelsLoop(ctx context.Context) {
	r.Models(ctx, true)
	r.CheckAll(false) // tests only what has no recent result
	t := time.NewTicker(modelsTTL)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Models(ctx, true)
			r.CheckAll(false)
		}
	}
}

var (
	reQuoted = regexp.MustCompile(`'([a-z][a-z0-9.\[\]-]*)'`)
	reParens = regexp.MustCompile(`\(([a-z]+(?:,\s*[a-z]+)+)\)`)
)

// helpBlock cuts an option's text out of --help (up to the next option).
func helpBlock(help, flag string) string {
	i := strings.Index(help, flag)
	if i < 0 {
		return ""
	}
	rest := help[i+len(flag):]
	if j := strings.Index(rest, "\n  -"); j >= 0 {
		rest = rest[:j]
	}
	return strings.Join(strings.Fields(rest), " ")
}

var claudeAliasInfo = map[string]string{
	"opus":   "The most capable; always the newest version",
	"sonnet": "A balance of quality, speed and cost; always the newest version",
	"haiku":  "The fastest and cheapest; always the newest version",
	"fable":  "Always the newest version of the Fable family",
}

func (r *Runner) claudeModels(ctx context.Context) RuntimeModels {
	out := RuntimeModels{Runtime: "claude", FetchedAt: time.Now(), Efforts: []string{"low", "medium", "high", "xhigh", "max"}}
	help := runCmd(ctx, r.cfg.ClaudeBin, "--help")
	out.Installed = help.ok
	if !help.ok {
		out.Error = "claude not found on the server"
		return out
	}
	text := help.stdout + "\n" + help.stderr

	// Aliases the CLI itself mentions + the classic aliases, which are still valid.
	aliases := []string{}
	seen := map[string]bool{}
	for _, m := range reQuoted.FindAllStringSubmatch(helpBlock(text, "--model <model>"), -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			aliases = append(aliases, m[1])
		}
	}
	for _, a := range []string{"opus", "sonnet", "haiku"} {
		if !seen[a] {
			seen[a] = true
			aliases = append(aliases, a)
		}
	}
	for _, a := range aliases {
		desc := claudeAliasInfo[a]
		if desc == "" {
			desc = "Alias: always the newest version"
		}
		out.Models = append(out.Models, ModelOption{ID: a, Label: strings.ToUpper(a[:1]) + a[1:], Description: desc, Group: "alias"})
	}
	if m := reParens.FindStringSubmatch(helpBlock(text, "--effort <level>")); m != nil {
		out.Efforts = strings.Split(strings.ReplaceAll(m[1], " ", ""), ",")
	}
	out.Source = "claude --help"

	return out
}

type codexCatalog struct {
	Models []struct {
		Slug          string `json:"slug"`
		DisplayName   string `json:"display_name"`
		Description   string `json:"description"`
		Visibility    string `json:"visibility"`
		Priority      int    `json:"priority"`
		DefaultEffort string `json:"default_reasoning_level"`
		Levels        []struct {
			Effort string `json:"effort"`
		} `json:"supported_reasoning_levels"`
	} `json:"models"`
}

func (r *Runner) codexModels(ctx context.Context) RuntimeModels {
	out := RuntimeModels{Runtime: "codex", FetchedAt: time.Now()}
	var cat codexCatalog
	res := runCmd(ctx, r.cfg.CodexBin, "debug", "models")
	switch {
	case res.ok && json.Unmarshal([]byte(res.stdout), &cat) == nil && len(cat.Models) > 0:
		out.Installed, out.Source = true, "codex debug models"
	default:
		out.Installed = runCmd(ctx, r.cfg.CodexBin, "--version").ok
		if !out.Installed {
			out.Error = "codex not found on the server"
			return out
		}
		home := os.Getenv("CODEX_HOME")
		if home == "" {
			h, _ := os.UserHomeDir()
			home = filepath.Join(h, ".codex")
		}
		if b, err := os.ReadFile(filepath.Join(home, "models_cache.json")); err == nil && json.Unmarshal(b, &cat) == nil && len(cat.Models) > 0 {
			out.Source = "Codex cache"
		} else if b := runCmd(ctx, r.cfg.CodexBin, "debug", "models", "--bundled"); b.ok && json.Unmarshal([]byte(b.stdout), &cat) == nil {
			out.Source = "catalog built into Codex"
		} else {
			out.Error = "couldn't read the Codex catalog"
			return out
		}
	}
	sort.SliceStable(cat.Models, func(i, j int) bool { return cat.Models[i].Priority < cat.Models[j].Priority })
	seen := map[string]bool{}
	for _, m := range cat.Models {
		if m.Visibility == "hide" {
			continue
		}
		o := ModelOption{ID: m.Slug, Label: firstNonEmpty(m.DisplayName, m.Slug), Description: m.Description, Group: "model", DefaultEffort: m.DefaultEffort}
		for _, l := range m.Levels {
			o.Efforts = append(o.Efforts, l.Effort)
			if !seen[l.Effort] {
				seen[l.Effort] = true
				out.Efforts = append(out.Efforts, l.Effort)
			}
		}
		out.Models = append(out.Models, o)
	}
	return out
}

func (r *Runner) geminiModels(ctx context.Context) RuntimeModels {
	out := RuntimeModels{Runtime: "gemini", FetchedAt: time.Now(), Efforts: []string{}}
	res := runCmd(ctx, r.cfg.GeminiBin, "models", "-o", "json")
	var list []struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
		Description string `json:"description"`
	}
	if !res.ok || json.Unmarshal([]byte(res.stdout), &list) != nil {
		out.Installed = runCmd(ctx, r.cfg.GeminiBin, "--version").ok
		if !out.Installed {
			out.Error = "gemini not found on the server"
		} else {
			out.Error = "couldn't read the Gemini catalog (is the CLI signed in?)"
		}
		return out
	}
	out.Installed, out.Source = true, "gemini models"
	for _, m := range list {
		if m.ID == "" {
			continue
		}
		group := "model"
		if m.ID == "auto" {
			group = "alias"
		}
		out.Models = append(out.Models, ModelOption{ID: m.ID, Label: firstNonEmpty(m.DisplayName, m.ID), Description: m.Description, Group: group})
	}
	return out
}
