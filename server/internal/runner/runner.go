// Package runner runs the agents. The queue lives in the database (runs.status =
// 'queued'), so it survives restarts and parallelism scales just by changing
// FOREMAN_MAX_PARALLEL.
//
// Every run starts in a clean chat. Continuity comes from the cumulative summary
// (issues.summary) the agent itself rewrites when it finishes, plus the branch's
// commit log: a small context, a low cost.
package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"foreman/internal/config"
	"foreman/internal/hub"
	"foreman/internal/store"
)

type Runner struct {
	cfg  config.Config
	st   *store.Store
	hub  *hub.Hub
	wake chan struct{}

	mu     sync.Mutex
	active map[string]*activeRun // runID → processo

	repoLocks sync.Map // repoID → *sync.Mutex (fetch/worktree/merge no mesmo clone)

	models modelCache

	sandboxOnce sync.Once
	sandboxOK   bool
}

type activeRun struct {
	cmd       *exec.Cmd
	cancelled bool
}

func New(cfg config.Config, st *store.Store, h *hub.Hub) *Runner {
	return &Runner{cfg: cfg, st: st, hub: h, wake: make(chan struct{}, 1), active: map[string]*activeRun{}}
}

func (r *Runner) poke() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *Runner) lockRepo(id string) func() {
	m, _ := r.repoLocks.LoadOrStore(id, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// Start recovers interrupted runs and starts consuming the queue.
func (r *Runner) Start(ctx context.Context) {
	ids, err := r.st.RecoverInterrupted(ctx)
	if err != nil {
		log.Printf("runner: recover runs: %v", err)
	}
	// An interrupted run (the server went down) counts as a failure: the rules decide the stage.
	for _, id := range ids {
		r.st.Emit(ctx, store.Event{Kind: "run_finished", IssueID: id, Outcome: "failed"})
	}
	go r.refreshModelsLoop(ctx)
	go func() {
		for {
			r.dispatch(ctx)
			select {
			case <-ctx.Done():
				return
			case <-r.wake:
			case <-time.After(5 * time.Second):
			}
		}
	}()
}

func (r *Runner) running() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

func (r *Runner) dispatch(ctx context.Context) {
	for r.running() < r.cfg.MaxParallel {
		run, err := r.st.ClaimNextRun(ctx)
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				log.Printf("runner: fila: %v", err)
			}
			return
		}
		r.mu.Lock()
		r.active[run.ID] = &activeRun{}
		r.mu.Unlock()
		go func() {
			defer func() {
				if p := recover(); p != nil {
					log.Printf("runner: panic in run %s: %v", run.ID, p)
					r.st.FinishRun(context.Background(), run.ID, store.RunResult{Status: "failed", Error: fmt.Sprint(p)})
				}
				r.mu.Lock()
				delete(r.active, run.ID)
				r.mu.Unlock()
				r.poke()
			}()
			r.execute(ctx, run)
		}()
	}
}

// ---------- event publishing ----------

func (r *Runner) PublishIssue(ctx context.Context, id string) {
	if is, err := r.st.Issue(ctx, id); err == nil {
		r.hub.Publish(hub.Event{Type: "issue", WorkspaceID: is.WorkspaceID, Data: is})
	}
}

func (r *Runner) publishRun(run *store.Run) {
	r.hub.Publish(hub.Event{Type: "run", WorkspaceID: run.WorkspaceID, Data: run})
}

func (r *Runner) logEvent(ctx context.Context, run *store.Run, kind, body string) {
	ev, err := r.st.AddEvent(ctx, run.ID, kind, body)
	if err != nil {
		log.Printf("runner: evento: %v", err)
		return
	}
	r.hub.Publish(hub.Event{Type: "run_event", WorkspaceID: run.WorkspaceID, Data: map[string]any{"issueId": run.IssueID, "event": ev}})
}

func (r *Runner) systemComment(ctx context.Context, issue *store.Issue, runID *string, body string) {
	c, err := r.st.AddComment(ctx, store.Comment{IssueID: issue.ID, RunID: runID, Kind: "system", Body: body})
	if err == nil {
		r.hub.Publish(hub.Event{Type: "comment", WorkspaceID: issue.WorkspaceID, Data: c})
	}
}

// ---------- enfileirar / cancelar ----------

var ErrBusy = errors.New("this issue already has a run queued or running")

func (r *Runner) Enqueue(ctx context.Context, issue *store.Issue, agentID, kind, request string, userID *string) (*store.Run, error) {
	return r.enqueue(ctx, issue, agentID, kind, request, userID, false)
}

// EnqueueInStage: a run requested by a stage step. The issue stays in the stage while
// the agent works and the runner doesn't move it when it finishes; the stage's rule
// sequence decides the next step.
func (r *Runner) EnqueueInStage(ctx context.Context, issue *store.Issue, agentID, kind, request string) (*store.Run, error) {
	return r.enqueue(ctx, issue, agentID, kind, request, nil, true)
}

func (r *Runner) enqueue(ctx context.Context, issue *store.Issue, agentID, kind, request string, userID *string, hold bool) (*store.Run, error) {
	if _, err := r.st.ActiveRun(ctx, issue.ID); err == nil {
		return nil, ErrBusy
	}
	if agentID == "" && issue.AgentID != nil {
		agentID = *issue.AgentID
	}
	if agentID == "" {
		return nil, errors.New("assign an agent to the issue")
	}
	agent, err := r.st.Agent(ctx, agentID)
	if err != nil {
		return nil, errors.New("agent not found")
	}
	if kind == "followup" && strings.TrimSpace(request) == "" {
		return nil, errors.New("describe the adjustment")
	}
	// Without a repository there is nowhere to work: refuse right at the request (the rule
	// or the screen shows the reason and the issue stays where it is).
	r.st.SyncIssueRepos(ctx, issue.ID)
	if scope, err := r.st.IssueRepos(ctx, issue.ID); err == nil && len(scope) == 0 {
		return nil, errors.New("the workspace has no repository: add one under Workspace")
	}
	run, err := r.st.CreateRun(ctx, issue, agent, kind, request, userID, hold)
	if err != nil {
		return nil, err
	}
	// A request to the agent (board, comment, reply, a rule that doesn't wait): the
	// "Agent started" rules decide the stage. A stage step (hold) doesn't trigger them.
	if !hold {
		r.st.Emit(ctx, store.Event{Kind: "run_started", IssueID: issue.ID, ActorID: userID})
	}
	r.publishRun(run)
	r.PublishIssue(ctx, issue.ID)
	r.poke()
	return run, nil
}

func (r *Runner) Cancel(ctx context.Context, runID string) error {
	if ok, err := r.st.CancelQueuedRun(ctx, runID); err != nil {
		return err
	} else if ok {
		if run, err := r.st.Run(ctx, runID); err == nil {
			r.publishRun(run)
			r.PublishIssue(ctx, run.IssueID)
		}
		return nil
	}
	r.mu.Lock()
	a := r.active[runID]
	if a != nil {
		a.cancelled = true
	}
	r.mu.Unlock()
	if a != nil && a.cmd != nil && a.cmd.Process != nil {
		pid := a.cmd.Process.Pid
		syscall.Kill(-pid, syscall.SIGTERM) // the whole group: includes the agent's subprocesses
		time.AfterFunc(10*time.Second, func() { syscall.Kill(-pid, syscall.SIGKILL) })
	}
	return nil
}

func (r *Runner) isCancelled(runID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active[runID] != nil && r.active[runID].cancelled
}

// ---------- execution ----------

func (r *Runner) skillDir(s store.Skill) string { return r.cfg.Path("skills", s.Slug) }
func (r *Runner) issueDir(id string) string     { return r.cfg.Path("issues", id) }

// Materializes the database skills on disk for the agent to read (and run scripts).
func (r *Runner) materializeSkills(skills []store.Skill) {
	for _, s := range skills {
		dir := r.skillDir(s)
		os.MkdirAll(dir, 0o755)
		front := fmt.Sprintf("---\nname: %s\ndescription: %s\n---\n\n", s.Name, strings.ReplaceAll(s.Description, "\n", " "))
		os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(front+s.Content), 0o644)
		for _, f := range s.Files {
			p := filepath.Join(dir, filepath.Clean("/"+f.Path))
			os.MkdirAll(filepath.Dir(p), 0o755)
			mode := os.FileMode(0o644)
			if strings.HasPrefix(f.Content, "#!") {
				mode = 0o755
			}
			os.WriteFile(p, []byte(f.Content), mode)
		}
	}
}

func agentEnv(extra ...string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k := kv[:strings.IndexByte(kv, '=')]
		switch k {
		case "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "DATABASE_URL":
			continue
		}
		env = append(env, kv)
	}
	return append(env, extra...)
}

type agentCmd struct {
	bin      string
	args     []string
	preamble string
}

// Isolation: the agent runs without asking for approval, but inside the CLI's own
// sandbox (bubblewrap on Linux). It writes only to the issue's folder and to Foreman's
// package cache; the rest of the disk is read-only. Network allowed (installing
// dependencies, reading documentation).
func (r *Runner) sandboxed() bool {
	r.sandboxOnce.Do(func() {
		r.sandboxOK = runCmd(context.Background(), "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "true").ok
	})
	return r.sandboxOK
}

func (r *Runner) cacheDir() string {
	d := r.cfg.Path("cache")
	os.MkdirAll(d, 0o755)
	return d
}

// Package-manager caches point to Foreman's cache folder (outside it the sandbox
// doesn't allow writing).
func (r *Runner) cacheEnv() []string {
	c := r.cacheDir()
	return []string{
		"XDG_CACHE_HOME=" + c,
		"npm_config_cache=" + filepath.Join(c, "npm"),
		"npm_config_store_dir=" + filepath.Join(c, "pnpm"),
		"YARN_CACHE_FOLDER=" + filepath.Join(c, "yarn"),
		"PIP_CACHE_DIR=" + filepath.Join(c, "pip"),
		"GOCACHE=" + filepath.Join(c, "go-build"),
		"GOMODCACHE=" + filepath.Join(c, "go-mod"),
	}
}

func (r *Runner) agentCommand(a *store.Agent, wt, system string, addDirs, writable []string) agentCmd {
	sandbox := r.sandboxed()
	if a.Runtime == "codex" {
		args := []string{"exec", "--json", "--skip-git-repo-check", "-C", wt}
		for _, d := range append(addDirs, writable...) {
			args = append(args, "--add-dir", d)
		}
		if a.Model != "" {
			args = append(args, "-m", a.Model)
		}
		if a.Effort != "" {
			args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", a.Effort))
		}
		if sandbox {
			args = append(args, "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true")
		} else {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		}
		args = append(append(args, splitArgs(a.ExtraArgs)...), "-")
		pre := ""
		if system != "" {
			pre = system + "\n\n---\n\n" // Codex has no "append system prompt"
		}
		return agentCmd{bin: r.cfg.CodexBin, args: args, preamble: pre}
	}
	args := []string{"-p", "--output-format", "stream-json", "--verbose"}
	if a.Model != "" {
		args = append(args, "--model", a.Model)
	}
	if a.Effort != "" {
		args = append(args, "--effort", a.Effort)
	}
	if a.MaxBudgetUSD != nil && *a.MaxBudgetUSD > 0 {
		args = append(args, "--max-budget-usd", fmt.Sprintf("%.2f", *a.MaxBudgetUSD))
	}
	if system != "" {
		args = append(args, "--append-system-prompt", system)
	}
	for _, d := range append(addDirs, writable...) {
		args = append(args, "--add-dir", d)
	}
	if sandbox {
		settings, _ := json.Marshal(map[string]any{"sandbox": map[string]any{
			"enabled": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
			"network":    map[string]any{"allowedDomains": []string{"*"}},
			"filesystem": map[string]any{"allowWrite": writable},
		}})
		args = append(args, "--permission-mode", "acceptEdits", "--settings", string(settings))
	} else {
		args = append(args, "--dangerously-skip-permissions")
	}
	return agentCmd{bin: r.cfg.ClaudeBin, args: append(args, splitArgs(a.ExtraArgs)...)}
}

type outcome struct {
	exitErr  error
	result   *Entry
	lastText string
}

func (r *Runner) spawn(ctx context.Context, run *store.Run, ac agentCmd, input, wt string, env []string) outcome {
	cmd := exec.Command(ac.bin, ac.args...)
	cmd.Dir = wt
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return outcome{exitErr: fmt.Errorf("couldn't start %s: %w", ac.bin, err)}
	}
	r.mu.Lock()
	if a := r.active[run.ID]; a != nil {
		a.cmd = cmd
		if a.cancelled {
			syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		}
	}
	r.mu.Unlock()
	go func() {
		io.WriteString(stdin, input)
		stdin.Close()
	}()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 4<<20)
		for sc.Scan() {
			t := strings.TrimSpace(sc.Text())
			// Codex writes progress to stderr; it is only worth showing what looks like an error.
			if t != "" && (run.Runtime != "codex" || strings.Contains(strings.ToLower(t), "error")) {
				r.logEvent(ctx, run, "error", clip(t, 800))
			}
		}
	}()

	var o outcome
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 256*1024), 32<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var entries []Entry
		if run.Runtime == "codex" {
			entries = normalizeCodex(line)
		} else {
			entries = normalizeClaude(line)
		}
		for _, e := range entries {
			e := e
			switch e.Kind {
			case "result":
				o.result = &e
				body := e.Body
				if e.Cost > 0 {
					body += fmt.Sprintf(" · US$ %.4f", e.Cost)
				}
				r.logEvent(ctx, run, "result", body+fmt.Sprintf(" · %d in · %d cache · %d out", e.In, e.Cached, e.Out))
			case "text":
				o.lastText = e.Body
				r.logEvent(ctx, run, e.Kind, e.Body)
			default:
				r.logEvent(ctx, run, e.Kind, e.Body)
			}
		}
	}
	wg.Wait()
	o.exitErr = cmd.Wait()
	return o
}

// repoWork is one of the issue's repositories, already prepared on disk.
type repoWork struct {
	store.RepoScope
	slug string // name of the subfolder in the issue's directory
	wt   string // worktree
}

func (w *repoWork) base() string { return w.IssueRepo.BaseBranch }

// slugs gives each repository a unique, readable subfolder.
func slugs(scope []store.RepoScope) []string {
	seen := map[string]int{}
	out := make([]string, len(scope))
	for i, s := range scope {
		slug := store.Slugify(s.Name, 40)
		if n := seen[slug]; n > 0 {
			slug = fmt.Sprintf("%s-%d", slug, n+1)
		}
		seen[store.Slugify(s.Name, 40)]++
		out[i] = slug
	}
	return out
}

// prepare updates the clones and ensures one worktree per repository, in parallel
// (the fetch is what takes longest). Clones are shared between issues, so a new
// worktree only costs the checkout.
func (r *Runner) prepare(ctx context.Context, run *store.Run, issue *store.Issue) ([]*repoWork, error) {
	r.st.SyncIssueRepos(ctx, issue.ID)
	scope, err := r.st.IssueRepos(ctx, issue.ID)
	if err != nil {
		return nil, err
	}
	if len(scope) == 0 {
		return nil, errors.New("the workspace has no repository: add one under Workspace")
	}
	root := r.worktreeDir(issue.ID)
	// Old layout (one worktree straight in the issue's folder): recreate it in the new one.
	if fileExists(filepath.Join(root, ".git")) {
		os.RemoveAll(root)
	}
	names := slugs(scope)
	works := make([]*repoWork, len(scope))
	errs := make([]error, len(scope))
	var wg sync.WaitGroup
	for i := range scope {
		w := &repoWork{RepoScope: scope[i], slug: names[i], wt: filepath.Join(root, names[i])}
		works[i] = w
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			unlock := r.lockRepo(w.ID)
			defer unlock()
			repoDir, err := r.syncRepo(ctx, w.ID, w.URL)
			if err != nil {
				errs[i] = fmt.Errorf("%s: %w", w.Name, err)
				return
			}
			if w.IssueRepo.BaseBranch == "" || w.IssueRepo.TargetBranch == "" {
				def, err := defaultBranch(ctx, repoDir)
				if err != nil && w.IssueRepo.BaseBranch == "" {
					errs[i] = fmt.Errorf("%s: %w", w.Name, err)
					return
				}
				if w.IssueRepo.BaseBranch == "" {
					w.IssueRepo.BaseBranch = def
				}
				if w.IssueRepo.TargetBranch == "" {
					w.IssueRepo.TargetBranch = w.IssueRepo.BaseBranch
				}
				r.st.SetRepoBranches(ctx, issue.ID, w.ID, w.IssueRepo.BaseBranch, w.IssueRepo.TargetBranch)
			}
			created, err := r.ensureWorktree(ctx, repoDir, w.wt, issue.Branch, w.base())
			if err != nil {
				errs[i] = fmt.Errorf("%s: %w", w.Name, err)
				return
			}
			if created {
				r.logEvent(ctx, run, "info", fmt.Sprintf("%s/ → branch %s from %s", w.slug, issue.Branch, w.base()))
			}
		}(i)
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return works, nil
}

func (r *Runner) execute(ctx context.Context, run *store.Run) {
	r.publishRun(run)
	issue, err := r.st.Issue(ctx, run.IssueID)
	if err != nil {
		r.st.FinishRun(ctx, run.ID, store.RunResult{Status: "failed", Error: "issue not found"})
		return
	}
	r.PublishIssue(ctx, issue.ID)

	var works []*repoWork
	var outcome runOutcome
	res := store.RunResult{Status: "failed"}
	defer func() {
		if r.isCancelled(run.ID) {
			res.Status, res.Error = "cancelled", "Cancelada."
		}
		if res.Error != "" {
			r.logEvent(ctx, run, "error", res.Error)
		}
		final, _ := r.st.FinishRun(ctx, run.ID, res)
		// The result becomes the "run finished" event; the workflow rules decide where
		// the issue goes. The AI declares whether it finished; without a declaration, it
		// counts as done.
		kind := outcome.Kind
		switch {
		case res.Status == "cancelled":
			kind = "cancelled"
		case res.Status == "failed":
			kind = "failed"
		case kind == "":
			kind = "done"
		}
		r.st.Emit(ctx, store.Event{Kind: "run_finished", IssueID: issue.ID, Outcome: kind, ActorID: run.CreatedBy})
		if res.Status == "failed" {
			r.systemComment(ctx, issue, &run.ID, "The run failed: "+res.Error)
		}
		if final != nil {
			r.publishRun(final)
		}
		r.PublishIssue(ctx, issue.ID)
	}()

	ws, err := r.st.Workspace(ctx, issue.WorkspaceID)
	if err != nil {
		res.Error = "workspace not found"
		return
	}
	if run.AgentID == nil {
		res.Error = "agente removido"
		return
	}
	agent, err := r.st.Agent(ctx, *run.AgentID)
	if err != nil {
		res.Error = "agent not found"
		return
	}
	var requester *store.User
	if run.CreatedBy != nil {
		requester, _ = r.st.UserByID(ctx, *run.CreatedBy)
	}

	r.logEvent(ctx, run, "info", "Preparing the repositories")
	if works, err = r.prepare(ctx, run, issue); err != nil {
		res.Error = err.Error()
		return
	}
	author := agent.Name + " (Foreman)"
	ref := fmt.Sprintf("%s-%d", ws.Key, issue.Number)

	// --- conflict: bring the target into the issue's branch in each locked repo ---
	conflicts := map[string][]string{}
	if run.Kind == "conflict" {
		for _, w := range works {
			if !w.IssueRepo.Conflict {
				continue
			}
			target := w.IssueRepo.TargetBranch
			if mergeInProgress(ctx, w.wt) {
				r.logEvent(ctx, run, "info", w.slug+": resuming the merge that was left halfway")
			} else {
				if _, err := commitAll(ctx, w.wt, ref+" "+issue.Title+" (pending changes)", author); err != nil {
					res.Error = w.Name + ": " + err.Error()
					return
				}
				r.logEvent(ctx, run, "info", fmt.Sprintf("%s: git merge origin/%s → %s", w.slug, target, issue.Branch))
				m := runGit(ctx, w.wt, "-c", "user.name="+author, "-c", "user.email=foreman@localhost", "merge", "--no-edit", "origin/"+target)
				if m.ok {
					r.publishBranch(ctx, run, w, issue.Branch)
					r.st.SetRepoConflict(ctx, issue.ID, w.ID, "", false)
					r.logEvent(ctx, run, "info", w.slug+": merge without conflicts")
					continue
				}
			}
			files := conflictedFiles(ctx, w.wt)
			if len(files) == 0 {
				res.Error = w.Name + ": the merge failed without file conflicts; check the worktree"
				return
			}
			conflicts[w.slug] = files
			r.logEvent(ctx, run, "info", w.slug+": conflicts in "+strings.Join(files, ", "))
		}
		if len(conflicts) == 0 {
			r.logEvent(ctx, run, "info", "Nothing for the AI to resolve.")
			res.Status = "succeeded"
			return
		}
	}

	// --- skills, resumo e prompt ---
	skills, err := r.st.SkillsFor(ctx, append(append([]string{}, agent.SkillIDs...), issue.SkillIDs...))
	if err != nil {
		res.Error = err.Error()
		return
	}
	r.materializeSkills(skills)
	idir := r.issueDir(issue.ID)
	os.MkdirAll(idir, 0o755)
	summaryPath := filepath.Join(idir, "README.md")
	os.WriteFile(summaryPath, []byte(issue.Summary), 0o644)
	statusPath := filepath.Join(idir, "STATUS")
	os.Remove(statusPath)
	history := ""
	if past, err := r.st.ListRuns(ctx, issue.ID); err == nil {
		history = runHistory(past, run.ID)
	}

	cwd := r.worktreeDir(issue.ID)
	if len(works) == 1 {
		cwd = works[0].wt
	}
	var prs []promptRepo
	for _, w := range works {
		pr := promptRepo{Slug: w.slug, Path: w.wt, Name: w.Name, Description: w.Description, Base: w.base(),
			Commits: runGit(ctx, w.wt, "log", "-20", "--format=%h %s", "origin/"+w.base()+"..HEAD").stdout, Conflicts: conflicts[w.slug]}
		prs = append(prs, pr)
	}
	system := buildSystem(agent, skills, r.skillDir)
	prompt := buildPrompt(promptInput{
		Key: ws.Key, Issue: issue, Repos: prs, Root: cwd, Kind: run.Kind, Request: run.Request, Requester: requester,
		SummaryPath: summaryPath, StatusPath: statusPath, History: history,
	})
	r.logEvent(ctx, run, "prompt", "<!-- system -->\n"+system+"\n\n<!-- prompt -->\n"+prompt)
	addDirs := []string{idir}
	if len(works) == 1 {
		addDirs = append(addDirs, r.worktreeDir(issue.ID))
	}
	for _, s := range skills {
		addDirs = append(addDirs, r.skillDir(s))
	}
	ac := r.agentCommand(agent, cwd, system, addDirs, []string{idir, r.cacheDir()})
	desc := agent.Runtime
	if agent.Model != "" {
		desc += " " + agent.Model
	}
	r.logEvent(ctx, run, "info", fmt.Sprintf("%s · %s · %d skill(s) · %d repositor(ies)", agent.Name, desc, len(skills), len(works)))
	if !r.sandboxed() {
		r.logEvent(ctx, run, "info", "Sandbox unavailable (bubblewrap): the agent runs without disk isolation. Install the bubblewrap package on the server.")
	}

	o := r.spawn(ctx, run, ac, ac.preamble+prompt, cwd, agentEnv(append(r.cacheEnv(),
		"FOREMAN_SUMMARY="+summaryPath,
		"FOREMAN_STATUS="+statusPath,
		"FOREMAN_ISSUE="+ref,
	)...))
	if o.result != nil {
		res.CostUSD, res.InputTokens, res.CachedTokens, res.OutputTokens = o.result.Cost, o.result.In, o.result.Cached, o.result.Out
	}

	// --- commit and publish, repo by repo (failures included: nothing is lost) ---
	label := ""
	if run.Kind != "initial" {
		label = " (" + map[string]string{"followup": "ajuste", "conflict": "conflito"}[run.Kind] + ")"
	}
	var shas, stats []string
	var cerr error
	for _, w := range works {
		sha, err := commitAll(ctx, w.wt, ref+" "+issue.Title+label, author)
		if err != nil {
			cerr = errors.Join(cerr, fmt.Errorf("%s: %w", w.Name, err))
			continue
		}
		if sha != "" {
			shas = append(shas, w.slug+" "+sha)
			r.logEvent(ctx, run, "info", fmt.Sprintf("%s: commit %s", w.slug, sha))
		}
		if w.IssueRepo.Conflict && !mergeInProgress(ctx, w.wt) && conflicts[w.slug] != nil {
			r.st.SetRepoConflict(ctx, issue.ID, w.ID, "", false)
		}
		changed := r.hasCommits(ctx, w)
		r.st.SetRepoChanged(ctx, issue.ID, w.ID, changed)
		if changed && !mergeInProgress(ctx, w.wt) && (sha != "" || !refExists(ctx, w.wt, "refs/remotes/origin/"+issue.Branch)) {
			r.publishBranch(ctx, run, w, issue.Branch)
		}
		if st := runGit(ctx, w.wt, "diff", "--stat", "origin/"+w.base()+"...HEAD").stdout; st != "" {
			stats = append(stats, w.slug+"/\n"+st)
		}
	}
	res.CommitSHA = strings.Join(shas, ", ")

	// --- resumo ---
	newSummary, _ := os.ReadFile(summaryPath)
	if s := strings.TrimSpace(string(newSummary)); s != "" && s != strings.TrimSpace(issue.Summary) {
		r.st.SetIssueSummary(ctx, issue.ID, s)
	} else if !r.isCancelled(run.ID) {
		r.st.SetIssueSummary(ctx, issue.ID, fallbackSummary(issue, run, firstNonEmpty(finalText(o), o.lastText), strings.Join(stats, "\n\n")))
		r.logEvent(ctx, run, "info", "The agent didn't update the summary; I recorded an automatic one.")
	}

	// --- what the AI declared: done, waiting for someone, or incomplete ---
	outcome = readOutcome(statusPath)
	if outcome.Kind != "" {
		r.st.SetRunOutcome(ctx, run.ID, outcome.Kind, outcome.Note)
	}
	if outcome.Kind == "waiting" || outcome.Kind == "incomplete" {
		label := map[string]string{"waiting": "The AI needs you", "incomplete": "The AI couldn't finish"}[outcome.Kind]
		r.systemComment(ctx, issue, &run.ID, fmt.Sprintf("**%s:** %s\n\nReply with a comment sent to the agent to continue.", label, firstNonEmpty(outcome.Note, "no details")))
	}

	// --- the agent's answer becomes a comment on the issue ---
	if text := strings.TrimSpace(firstNonEmpty(finalText(o), o.lastText)); text != "" {
		if c, err := r.st.AddComment(ctx, store.Comment{IssueID: issue.ID, AgentID: &agent.ID, RunID: &run.ID, Kind: "agent", Body: text}); err == nil {
			r.hub.Publish(hub.Event{Type: "comment", WorkspaceID: issue.WorkspaceID, Data: c})
		}
	}

	switch {
	case cerr != nil:
		res.Error = cerr.Error()
	case o.exitErr != nil:
		res.Error = "the agent ended with an error: " + o.exitErr.Error()
		if o.result != nil && o.result.IsError {
			res.Error = o.result.Body
		}
	case o.result != nil && o.result.IsError:
		res.Error = o.result.Body
	default:
		res.Status = "succeeded"
	}
}

func finalText(o outcome) string {
	if o.result != nil {
		return o.result.Final
	}
	return ""
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (r *Runner) publishBranch(ctx context.Context, run *store.Run, w *repoWork, branch string) {
	if err := pushBranch(ctx, w.wt, branch); err != nil {
		r.logEvent(ctx, run, "error", w.slug+": couldn't publish the branch to the remote: "+err.Error())
		return
	}
	r.logEvent(ctx, run, "info", w.slug+": branch publicada "+branch)
}

// hasCommits: the issue's branch has commits beyond the base in this repository.
func (r *Runner) hasCommits(ctx context.Context, w *repoWork) bool {
	if !fileExists(w.wt) {
		return false
	}
	return runGit(ctx, w.wt, "log", "-1", "--format=%h", "origin/"+w.base()+"..HEAD").stdout != ""
}

func fallbackSummary(issue *store.Issue, run *store.Run, text, stat string) string {
	var b strings.Builder
	if strings.TrimSpace(issue.Summary) != "" {
		b.WriteString(strings.TrimSpace(issue.Summary) + "\n\n")
	} else {
		fmt.Fprintf(&b, "# %s\n\n", issue.Title)
	}
	fmt.Fprintf(&b, "## Run of %s (%s)\n_Generated automatically: the agent didn't update the summary._\n\n", time.Now().Format("01/02 15:04"), run.Kind)
	if run.Request != "" {
		b.WriteString("**Request:** " + run.Request + "\n\n")
	}
	if text != "" {
		b.WriteString("**Final answer:**\n" + clip(text, 1500) + "\n\n")
	}
	if stat != "" {
		b.WriteString("**Files:**\n```\n" + stat + "\n```\n")
	}
	return b.String()
}

// ---------- declared result and history ----------

type runOutcome struct{ Kind, Note string }

// readOutcome reads the line the AI wrote in STATUS: "done", "waiting: …" or
// "incomplete: …" (the Portuguese words from before the rename are still accepted).
func readOutcome(path string) runOutcome {
	b, err := os.ReadFile(path)
	if err != nil {
		return runOutcome{}
	}
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(string(b)), "\n", 2)[0])
	head, note, _ := strings.Cut(line, ":")
	note = strings.TrimSpace(note)
	switch strings.ToLower(strings.Trim(strings.TrimSpace(head), "`*")) {
	case "concluido", "concluído", "done":
		return runOutcome{"done", note}
	case "aguardando", "waiting":
		return runOutcome{"waiting", note}
	case "incompleto", "incomplete":
		return runOutcome{"incomplete", note}
	}
	return runOutcome{}
}

// runHistory summarizes the issue's previous runs for the next chat.
func runHistory(runs []store.Run, current string) string {
	kinds := map[string]string{"initial": "initial request", "followup": "adjustment", "conflict": "resolve conflict"}
	outcomes := map[string]string{"done": "done", "waiting": "waiting for someone", "incomplete": "incomplete"}
	var lines []string
	for _, r := range runs {
		if r.ID == current || r.Status == "queued" || r.Status == "running" {
			continue
		}
		line := fmt.Sprintf("- %s · %s · %s", r.CreatedAt.Format("2006-01-02 15:04"), r.AgentName, kinds[r.Kind])
		if req := strings.TrimSpace(r.Request); req != "" {
			line += fmt.Sprintf(": %q", clip(strings.ReplaceAll(req, "\n", " "), 160))
		}
		result := map[string]string{"succeeded": "ok", "failed": "failed", "cancelled": "cancelled"}[r.Status]
		if o := outcomes[r.Outcome]; o != "" {
			result = o
		}
		if r.OutcomeNote != "" {
			result += " — " + clip(r.OutcomeNote, 160)
		}
		line += " → " + result
		if r.CommitSHA != "" {
			line += " (" + r.CommitSHA + ")"
		}
		lines = append(lines, line)
	}
	if len(lines) > 15 {
		lines = append([]string{fmt.Sprintf("- … %d older runs", len(lines)-15)}, lines[len(lines)-15:]...)
	}
	return strings.Join(lines, "\n")
}
