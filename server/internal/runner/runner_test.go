package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"foreman/internal/config"
	"foreman/internal/store"
)

func TestReadOutcome(t *testing.T) {
	cases := []struct{ content, kind, note string }{
		{"done", "done", ""},
		{"DONE\n", "done", ""},
		{"`done`", "done", ""},
		{"waiting: blue or green?", "waiting", "blue or green?"},
		{"waiting: a: b", "waiting", "a: b"},
		{"incomplete: no access\nsecond line", "incomplete", "no access"},
		{"concluído", "done", ""},
		{"aguardando: x", "waiting", "x"},
		{"banana", "", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		p := filepath.Join(t.TempDir(), "STATUS")
		os.WriteFile(p, []byte(c.content), 0o644)
		if got := readOutcome(p); got.Kind != c.kind || got.Note != c.note {
			t.Errorf("%q: got %+v", c.content, got)
		}
	}
	if got := readOutcome(filepath.Join(t.TempDir(), "missing")); got.Kind != "" {
		t.Errorf("a missing file should declare nothing, got %+v", got)
	}
}

func TestSplitArgs(t *testing.T) {
	cases := map[string][]string{
		"":                  nil,
		"--foo":             {"--foo"},
		`--foo "a b" --bar`: {"--foo", "a b", "--bar"},
		`--x 'c d'  e`:      {"--x", "c d", "e"},
		`--empty ""`:        {"--empty", ""},
	}
	for in, want := range cases {
		if got := splitArgs(in); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %#v, want %#v", in, got, want)
		}
	}
}

func TestSlugsAreUnique(t *testing.T) {
	scope := []store.RepoScope{{Repo: store.Repo{Name: "API"}}, {Repo: store.Repo{Name: "api!"}}, {Repo: store.Repo{Name: "Web App"}}}
	got := slugs(scope)
	if want := []string{"api", "api-2", "web-app"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestRedactHidesCredentials(t *testing.T) {
	cases := map[string]string{
		"https://ghp_abc@github.com/o/r.git":       "https://***@github.com/o/r.git",
		"https://user:pass@host/x":                 "https://***@host/x",
		"fatal: unable to access 'https://t@h/r/'": "fatal: unable to access 'https://***@h/r/'",
		"git@github.com:o/r.git":                   "git@github.com:o/r.git",
		"file:///remote/x.git":                     "file:///remote/x.git",
	}
	for in, want := range cases {
		if got := redact(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestGitHubRepo(t *testing.T) {
	cases := map[string]string{
		"git@github.com:o/r.git":         "o/r",
		"https://github.com/o/r":         "o/r",
		"https://tok@github.com/o/r.git": "o/r",
		"https://gitlab.com/o/r.git":     "",
		"file:///remote/r.git":           "",
	}
	for in, want := range cases {
		got, ok := gitHubRepo(in)
		if ok != (want != "") || got != want {
			t.Errorf("%q: got %q %v", in, got, ok)
		}
	}
}

func TestNormalizeClaude(t *testing.T) {
	res := normalizeClaude([]byte(`{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","total_cost_usd":1.5,"usage":{"input_tokens":3,"cache_creation_input_tokens":2,"cache_read_input_tokens":7,"output_tokens":4}}`))
	if len(res) != 1 || !res[0].IsError || res[0].Cost != 1.5 || res[0].In != 5 || res[0].Cached != 7 || res[0].Out != 4 {
		t.Fatalf("result: %+v", res)
	}
	if !strings.Contains(res[0].Body, "error_max_budget_usd") {
		t.Errorf("a failure without text should say the subtype: %q", res[0].Body)
	}
	tool := normalizeClaude([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm   test"}}]}}`))
	if tool[0].Kind != "tool" || tool[0].Body != "Bash  npm test" {
		t.Errorf("tool: %+v", tool)
	}
	if plain := normalizeClaude([]byte(`not json`)); plain[0].Kind != "out" {
		t.Errorf("a non-JSON line should show as output: %+v", plain)
	}
}

func TestNormalizeCodex(t *testing.T) {
	res := normalizeCodex([]byte(`{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}`))
	if res[0].Kind != "result" || res[0].In != 60 || res[0].Cached != 40 || res[0].Out != 7 {
		t.Errorf("usage: %+v", res)
	}
	if e := normalizeCodex([]byte(`{"type":"turn.failed","error":{"message":"boom"}}`)); e[0].Kind != "error" || e[0].Body != "boom" {
		t.Errorf("failure: %+v", e)
	}
	if m := normalizeCodex([]byte(`{"type":"item.started","item":{"type":"agent_message","text":"x"}}`)); m != nil {
		t.Errorf("a message only counts when completed: %+v", m)
	}
}

func TestPromptAndHistory(t *testing.T) {
	is := &store.Issue{Number: 7, Title: "Fix", Description: "the description", Branch: "fm/k-7-fix", Summary: "# previous README"}
	one := []promptRepo{{Slug: "api", Path: "/wt/api", Name: "API", Base: "main"}}
	p := buildPrompt(promptInput{Key: "K", Issue: is, Repos: one, Kind: "followup", Request: "change this", SummaryPath: "/i/README.md", StatusPath: "/i/STATUS", History: "- earlier"})
	for _, want := range []string{"# K-7: Fix", "the description", "isolated git worktree", "# previous README", "- earlier", "## Adjustment request\nchange this", "/i/README.md", "/i/STATUS", "waiting: <what you need"} {
		if !strings.Contains(p, want) {
			t.Errorf("the prompt lacks %q", want)
		}
	}
	two := []promptRepo{{Slug: "api", Name: "API", Description: "the api", Base: "main", Conflicts: []string{"a.txt"}}, {Slug: "web", Name: "Web", Base: "dev"}}
	c := buildPrompt(promptInput{Key: "K", Issue: is, Repos: two, Kind: "conflict", Root: "/wt", SummaryPath: "s", StatusPath: "t"})
	for _, want := range []string{"`api/` — **API**: the api (base `main`)", "`web/` — **Web**: no description (base `dev`)", "- api/a.txt", "Don't run `git commit`"} {
		if !strings.Contains(c, want) {
			t.Errorf("the conflict prompt lacks %q", want)
		}
	}

	at := time.Date(2026, 1, 2, 3, 4, 0, 0, time.UTC)
	runs := []store.Run{
		{ID: "a", AgentName: "Claude", Kind: "initial", Status: "succeeded", Outcome: "waiting", OutcomeNote: "which?", CreatedAt: at, CommitSHA: "api abc"},
		{ID: "b", AgentName: "Codex", Kind: "followup", Request: "blue", Status: "failed", CreatedAt: at},
		{ID: "current", Kind: "followup", Status: "running", CreatedAt: at},
	}
	h := runHistory(runs, "current")
	if !strings.Contains(h, "waiting for someone — which?") || !strings.Contains(h, `"blue" → failed`) || strings.Contains(h, "current") {
		t.Errorf("history: %s", h)
	}
}

func TestClaudeCommandIsolation(t *testing.T) {
	budget := 2.5
	r := New(config.Config{ClaudeBin: "claude", CodexBin: "codex", DataDir: t.TempDir()}, nil, nil)
	a := &store.Agent{Runtime: "claude", Model: "sonnet", Effort: "high", MaxBudgetUSD: &budget, ExtraArgs: "--foo"}

	r.sandboxOnce.Do(func() { r.sandboxOK = true })
	ac := r.agentCommand(a, "/wt", "sys", []string{"/read"}, []string{"/issue"})
	if slices.Contains(ac.args, "--dangerously-skip-permissions") {
		t.Fatal("with a sandbox the agent can't skip the permissions")
	}
	i := slices.Index(ac.args, "--settings")
	if i < 0 {
		t.Fatalf("no --settings: %v", ac.args)
	}
	var s struct {
		Sandbox struct {
			Enabled                  bool
			AllowUnsandboxedCommands bool
			Filesystem               struct{ AllowWrite []string }
		}
	}
	if err := json.Unmarshal([]byte(ac.args[i+1]), &s); err != nil {
		t.Fatal(err)
	}
	if !s.Sandbox.Enabled || s.Sandbox.AllowUnsandboxedCommands || !slices.Contains(s.Sandbox.Filesystem.AllowWrite, "/issue") {
		t.Errorf("settings: %s", ac.args[i+1])
	}
	for _, want := range []string{"--model", "sonnet", "--effort", "high", "--max-budget-usd", "2.50", "--append-system-prompt", "sys", "--add-dir", "/read", "/issue", "--foo"} {
		if !slices.Contains(ac.args, want) {
			t.Errorf("missing %q in %v", want, ac.args)
		}
	}

	cx := r.agentCommand(&store.Agent{Runtime: "codex", Model: "m", Effort: "low"}, "/wt", "sys", nil, []string{"/issue"})
	if cx.bin != "codex" || !strings.HasPrefix(cx.preamble, "sys") || cx.args[len(cx.args)-1] != "-" {
		t.Errorf("codex: %+v", cx)
	}
	if !slices.Contains(cx.args, "workspace-write") || slices.Contains(cx.args, "--dangerously-bypass-approvals-and-sandbox") {
		t.Errorf("codex without the sandbox: %v", cx.args)
	}
}

func TestClaudeCommandWithoutSandbox(t *testing.T) {
	r := New(config.Config{ClaudeBin: "claude", DataDir: t.TempDir()}, nil, nil)
	r.sandboxOnce.Do(func() { r.sandboxOK = false })
	ac := r.agentCommand(&store.Agent{Runtime: "claude"}, "/wt", "", nil, nil)
	if !slices.Contains(ac.args, "--dangerously-skip-permissions") {
		t.Errorf("without bwrap, the isolation is the container's: %v", ac.args)
	}
}

// Gemini sends the assistant's text in deltas: they become one log line per message,
// written out when a tool starts or the run ends, and the result carries the tokens.
func TestGeminiParser(t *testing.T) {
	parse, end := parserFor("gemini")
	var got []Entry
	for _, l := range []string{
		`{"type":"init","session_id":"s1","model":"gemini-3.5-flash"}`,
		`{"type":"message","role":"user","content":"do it"}`,
		`{"type":"message","role":"assistant","content":"Let me ","delta":true}`,
		`{"type":"message","role":"assistant","content":"look.","delta":true}`,
		`{"type":"tool_use","tool_name":"run_shell_command","tool_id":"t1","parameters":{"command":"ls"}}`,
		`{"type":"tool_result","tool_id":"t1","status":"success","output":"a.txt"}`,
		`{"type":"message","role":"assistant","content":"Done.","delta":true}`,
		`{"type":"result","status":"success","stats":{"input_tokens":100,"output_tokens":20,"cached":30}}`,
	} {
		got = append(got, parse([]byte(l))...)
	}
	got = append(got, end()...)
	kinds := []string{}
	for _, e := range got {
		kinds = append(kinds, e.Kind)
	}
	want := "info text tool out text result"
	if strings.Join(kinds, " ") != want {
		t.Fatalf("kinds = %v, want %s", kinds, want)
	}
	if got[1].Body != "Let me look." || got[2].Body != "run_shell_command  ls" {
		t.Fatalf("bodies: %q, %q", got[1].Body, got[2].Body)
	}
	r := got[5]
	if r.In != 70 || r.Cached != 30 || r.Out != 20 || r.IsError || r.Final != "Let me look.Done." {
		t.Fatalf("result = %+v", r)
	}
	// Text still pending when the output ends is not lost.
	parse, end = parserFor("gemini")
	parse([]byte(`{"type":"message","role":"assistant","content":"partial","delta":true}`))
	if e := end(); len(e) != 1 || e[0].Body != "partial" {
		t.Fatalf("end() = %+v", e)
	}
	// A failed run.
	parse, _ = parserFor("gemini")
	if e := parse([]byte(`{"type":"result","status":"error","error":{"type":"x","message":"quota"}}`)); len(e) != 1 || !e[0].IsError || e[0].Body != "Failed: quota" {
		t.Fatalf("error result = %+v", e)
	}
}

// The connection test reads each CLI's answer: a reply is OK; an error says why.
func TestProbeParsers(t *testing.T) {
	if r, p := parseClaudeProbe([]byte(`{"type":"result","is_error":false,"result":"OK"}`)); r != "OK" || p != "" {
		t.Fatalf("claude ok: %q %q", r, p)
	}
	if _, p := parseClaudeProbe([]byte(`{"type":"result","is_error":true,"result":"Claude Opus is not available with the Claude Pro plan"}`)); !strings.Contains(p, "not available") {
		t.Fatalf("claude error: %q", p)
	}
	codexOK := `{"type":"thread.started","thread_id":"x"}
{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`
	if r, p := parseCodexProbe([]byte(codexOK)); r != "OK" || p != "" {
		t.Fatalf("codex ok: %q %q", r, p)
	}
	codexNoPlan := `{"type":"thread.started","thread_id":"x"}
{"type":"error","message":"You've hit your usage limit. Upgrade to Plus to continue."}
{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Plus to continue."}}`
	if r, p := parseCodexProbe([]byte(codexNoPlan)); r != "" || !strings.Contains(p, "Upgrade") {
		t.Fatalf("codex no plan: %q %q", r, p)
	}
	if r, p := parseGeminiProbe([]byte("Loaded cached credentials.\n{\n  \"response\": \"OK\",\n  \"stats\": {}\n}")); r != "OK" || p != "" {
		t.Fatalf("gemini ok: %q %q", r, p)
	}
	if _, p := parseGeminiProbe([]byte(`{"error":{"type":"Error","message":"Model not found: gemini-9"}}`)); !strings.Contains(p, "not found") {
		t.Fatalf("gemini error: %q", p)
	}
	// An error printed as indented JSON, over several lines.
	if m := jsonMessage("Error when talking to Gemini API\n{\n  \"error\": {\n    \"code\": 429,\n    \"message\": \"Quota exceeded for \\\"gemini-2.5-pro\\\"\"\n  }\n}"); m != `Quota exceeded for "gemini-2.5-pro"` {
		t.Fatalf("jsonMessage = %q", m)
	}
	if m := jsonMessage(`{"error":{"code":503,"message":"high demand"}} {"message":""}`); m != "high demand" {
		t.Fatalf("an empty message afterwards must be skipped: %q", m)
	}
	for _, e := range []string{"no answer in 2 minutes: { \"error\": { \"code\": 503, \"message\": \"This model is currently experiencing high demand.\" } }", "429 Too Many Requests", "Overloaded"} {
		if !busy(e) {
			t.Fatalf("should be busy: %q", e)
		}
	}
	for _, e := range []string{"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", "This model models/gemini-2.5-pro is no longer available to new users."} {
		if busy(e) {
			t.Fatalf("should not be busy: %q", e)
		}
	}
}

// Commits are in English: the agent's message (from $FOREMAN_COMMIT) after the key, or
// an English fallback. The issue title never goes in.
func TestCommitMessage(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "COMMIT_MSG")
	if m := commitMessage("FORE-1", p, "Claude", "initial"); m != "FORE-1: changes by Claude" {
		t.Fatalf("no file: %q", m)
	}
	if m := commitMessage("FORE-1", p, "Claude", "followup"); m != "FORE-1: adjustment by Claude" {
		t.Fatalf("no file, adjustment: %q", m)
	}
	os.WriteFile(p, []byte("FORE-1: feat: unique workspace names\r\n\nThe key was already unique.\n"), 0o644)
	if m := commitMessage("FORE-1", p, "Claude", "initial"); m != "FORE-1: feat: unique workspace names\n\nThe key was already unique." {
		t.Fatalf("with message: %q", m)
	}
	os.WriteFile(p, []byte("  \n"), 0o644)
	if m := commitMessage("FORE-1", p, "Claude", "initial"); m != "FORE-1: changes by Claude" {
		t.Fatalf("blank file: %q", m)
	}
}
