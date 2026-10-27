// Package runner executa os agentes. A fila mora no banco (runs.status =
// 'queued'), então sobrevive a reinícios e dá para escalar o paralelismo só
// mudando MULTICA_MAX_PARALLEL.
//
// Cada execução começa num chat limpo. A continuidade vem do resumo
// cumulativo (issues.summary) que o próprio agente reescreve ao terminar,
// mais o log de commits da branch: contexto pequeno, custo baixo.
package runner

import (
	"bufio"
	"context"
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

	"multica/internal/config"
	"multica/internal/hub"
	"multica/internal/store"
)

type Runner struct {
	cfg  config.Config
	st   *store.Store
	hub  *hub.Hub
	wake chan struct{}

	mu     sync.Mutex
	active map[string]*activeRun // runID → processo

	repoLocks sync.Map // repoID → *sync.Mutex (fetch/worktree/merge no mesmo clone)
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

// Start recupera execuções interrompidas e começa a consumir a fila.
func (r *Runner) Start(ctx context.Context) {
	ids, err := r.st.RecoverInterrupted(ctx)
	if err != nil {
		log.Printf("runner: recuperar execuções: %v", err)
	}
	for _, id := range ids {
		r.st.SetIssueStatus(ctx, id, "blocked")
	}
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
					log.Printf("runner: pânico na execução %s: %v", run.ID, p)
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

// ---------- publicação de eventos ----------

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

var ErrBusy = errors.New("essa issue já tem uma execução na fila ou rodando")

func (r *Runner) Enqueue(ctx context.Context, issue *store.Issue, agentID, kind, request string, userID *string) (*store.Run, error) {
	if _, err := r.st.ActiveRun(ctx, issue.ID); err == nil {
		return nil, ErrBusy
	}
	if agentID == "" && issue.AgentID != nil {
		agentID = *issue.AgentID
	}
	if agentID == "" {
		return nil, errors.New("atribua um agente à issue")
	}
	agent, err := r.st.Agent(ctx, agentID)
	if err != nil {
		return nil, errors.New("agente não encontrado")
	}
	if kind == "followup" && strings.TrimSpace(request) == "" {
		return nil, errors.New("descreva o ajuste")
	}
	run, err := r.st.CreateRun(ctx, issue, agent, kind, request, userID)
	if err != nil {
		return nil, err
	}
	r.publishRun(run)
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
		syscall.Kill(-pid, syscall.SIGTERM) // grupo inteiro: inclui os subprocessos do agente
		time.AfterFunc(10*time.Second, func() { syscall.Kill(-pid, syscall.SIGKILL) })
	}
	return nil
}

func (r *Runner) isCancelled(runID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active[runID] != nil && r.active[runID].cancelled
}

// ---------- execução ----------

func (r *Runner) skillDir(s store.Skill) string { return r.cfg.Path("skills", s.Slug) }
func (r *Runner) issueDir(id string) string     { return r.cfg.Path("issues", id) }

// Materializa as skills do banco em disco para o agente ler (e rodar scripts).
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

func writeEnvFiles(wt string, files []store.FileEntry) []string {
	var paths []string
	for _, f := range files {
		rel := strings.TrimPrefix(filepath.Clean("/"+f.Path), "/")
		if rel == "" {
			continue
		}
		p := filepath.Join(wt, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(f.Content), 0o600)
		paths = append(paths, rel)
	}
	return paths
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

func (r *Runner) agentCommand(a *store.Agent, wt, system string, addDirs []string) agentCmd {
	if a.Runtime == "codex" {
		args := []string{"exec", "--json", "--skip-git-repo-check", "-C", wt}
		for _, d := range addDirs {
			args = append(args, "--add-dir", d)
		}
		if a.Model != "" {
			args = append(args, "-m", a.Model)
		}
		if a.Effort != "" {
			args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", a.Effort))
		}
		if a.Permission == "full" {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		} else {
			args = append(args, "-s", "workspace-write")
		}
		args = append(append(args, splitArgs(a.ExtraArgs)...), "-")
		pre := ""
		if system != "" {
			pre = system + "\n\n---\n\n" // Codex não tem "append system prompt"
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
	for _, d := range addDirs {
		args = append(args, "--add-dir", d)
	}
	if a.Permission == "full" {
		args = append(args, "--dangerously-skip-permissions")
	} else {
		args = append(args, "--permission-mode", "acceptEdits")
	}
	return agentCmd{bin: r.cfg.ClaudeBin, args: append(args, splitArgs(a.ExtraArgs)...)}
}

func (r *Runner) runShell(ctx context.Context, run *store.Run, dir, script string) error {
	cmd := exec.CommandContext(ctx, "bash", "-lc", script)
	cmd.Dir = dir
	cmd.Env = agentEnv()
	out, err := cmd.CombinedOutput()
	for _, l := range lines(string(out)) {
		r.logEvent(ctx, run, "out", clip(l, 600))
	}
	return err
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
		return outcome{exitErr: fmt.Errorf("não foi possível iniciar %s: %w", ac.bin, err)}
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
			// Codex escreve progresso no stderr; só vale mostrar o que parece erro.
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

// repoWork é um repositório da issue já preparado no disco.
type repoWork struct {
	store.RepoScope
	slug    string // nome da subpasta no diretório da issue
	wt      string // worktree
	exclude []string
}

func (w *repoWork) base() string { return w.IssueRepo.BaseBranch }

// slugs dá a cada repositório uma subpasta única e legível.
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

// prepare atualiza os clones e garante um worktree por repositório, em
// paralelo (o fetch é o que mais demora). Clones são compartilhados entre
// issues, então um worktree novo custa só o checkout.
func (r *Runner) prepare(ctx context.Context, run *store.Run, issue *store.Issue) ([]*repoWork, error) {
	r.st.SyncIssueRepos(ctx, issue.ID)
	scope, err := r.st.IssueRepos(ctx, issue.ID)
	if err != nil {
		return nil, err
	}
	if len(scope) == 0 {
		return nil, errors.New("o workspace não tem repositório: cadastre um em Workspace e membros")
	}
	root := r.worktreeDir(issue.ID)
	// Layout antigo (um worktree direto na pasta da issue): recria no novo.
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
			created, err := r.ensureWorktree(ctx, repoDir, w.wt, issue.Branch, w.base())
			if err != nil {
				errs[i] = fmt.Errorf("%s: %w", w.Name, err)
				return
			}
			if created {
				os.Remove(r.setupMark(issue.ID, w.ID))
				r.logEvent(ctx, run, "info", fmt.Sprintf("%s/ → branch %s a partir de %s", w.slug, issue.Branch, w.base()))
			}
		}(i)
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	for _, w := range works {
		w.exclude = writeEnvFiles(w.wt, w.EnvFiles)
		mark := r.setupMark(issue.ID, w.ID)
		if script := strings.TrimSpace(w.SetupScript); script != "" && !fileExists(mark) {
			r.logEvent(ctx, run, "info", fmt.Sprintf("Setup de %s: %s", w.Name, strings.SplitN(script, "\n", 2)[0]))
			if err := r.runShell(ctx, run, w.wt, script); err != nil {
				return nil, fmt.Errorf("o script de setup de %s falhou: %w", w.Name, err)
			}
			os.MkdirAll(filepath.Dir(mark), 0o755)
			os.WriteFile(mark, nil, 0o644)
		}
	}
	return works, nil
}

func (r *Runner) setupMark(issueID, repoID string) string {
	return filepath.Join(r.issueDir(issueID), "setup-ok-"+repoID)
}

func (r *Runner) execute(ctx context.Context, run *store.Run) {
	r.publishRun(run)
	issue, err := r.st.Issue(ctx, run.IssueID)
	if err != nil {
		r.st.FinishRun(ctx, run.ID, store.RunResult{Status: "failed", Error: "issue não encontrada"})
		return
	}
	r.st.SetIssueStatus(ctx, issue.ID, "in_progress")
	r.PublishIssue(ctx, issue.ID)

	var works []*repoWork
	res := store.RunResult{Status: "failed"}
	defer func() {
		if r.isCancelled(run.ID) {
			res.Status, res.Error = "cancelled", "Cancelada."
		}
		if res.Error != "" {
			r.logEvent(ctx, run, "error", res.Error)
		}
		final, _ := r.st.FinishRun(ctx, run.ID, res)
		next := "blocked"
		switch res.Status {
		case "succeeded":
			next = "in_review"
		case "cancelled":
			next = "backlog"
			for _, w := range works {
				if r.hasCommits(ctx, w) {
					next = "in_review"
				}
			}
		}
		r.st.SetIssueStatus(ctx, issue.ID, next)
		if res.Status == "failed" {
			r.systemComment(ctx, issue, &run.ID, "A execução falhou: "+res.Error)
		}
		if final != nil {
			r.publishRun(final)
		}
		r.PublishIssue(ctx, issue.ID)
	}()

	ws, err := r.st.Workspace(ctx, issue.WorkspaceID)
	if err != nil {
		res.Error = "workspace não encontrado"
		return
	}
	if run.AgentID == nil {
		res.Error = "agente removido"
		return
	}
	agent, err := r.st.Agent(ctx, *run.AgentID)
	if err != nil {
		res.Error = "agente não encontrado"
		return
	}
	var requester *store.User
	if run.CreatedBy != nil {
		requester, _ = r.st.UserByID(ctx, *run.CreatedBy)
	}

	r.logEvent(ctx, run, "info", "Preparando os repositórios")
	if works, err = r.prepare(ctx, run, issue); err != nil {
		res.Error = err.Error()
		return
	}
	author := agent.Name + " (Multica)"
	ref := fmt.Sprintf("%s-%d", ws.Key, issue.Number)

	// --- conflito: traz o destino para a branch da issue em cada repo travado ---
	conflicts := map[string][]string{}
	if run.Kind == "conflict" {
		for _, w := range works {
			if !w.IssueRepo.Conflict {
				continue
			}
			target := w.IssueRepo.TargetBranch
			if mergeInProgress(ctx, w.wt) {
				r.logEvent(ctx, run, "info", w.slug+": continuando o merge que ficou pela metade")
			} else {
				if _, err := commitAll(ctx, w.wt, ref+" "+issue.Title+" (pendências)", author, w.exclude); err != nil {
					res.Error = w.Name + ": " + err.Error()
					return
				}
				r.logEvent(ctx, run, "info", fmt.Sprintf("%s: git merge origin/%s → %s", w.slug, target, issue.Branch))
				m := runGit(ctx, w.wt, "-c", "user.name="+author, "-c", "user.email=multica@localhost", "merge", "--no-edit", "origin/"+target)
				if m.ok {
					r.publishBranch(ctx, run, w, issue.Branch)
					r.st.SetRepoConflict(ctx, issue.ID, w.ID, "", false)
					r.logEvent(ctx, run, "info", w.slug+": merge sem conflitos")
					continue
				}
			}
			files := conflictedFiles(ctx, w.wt)
			if len(files) == 0 {
				res.Error = w.Name + ": o merge falhou sem conflitos de arquivo; veja o worktree"
				return
			}
			conflicts[w.slug] = files
			r.logEvent(ctx, run, "info", w.slug+": conflitos em "+strings.Join(files, ", "))
		}
		if len(conflicts) == 0 {
			r.logEvent(ctx, run, "info", "Nada para a IA resolver.")
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
	summaryPath := filepath.Join(idir, "RESUMO.md")
	os.WriteFile(summaryPath, []byte(issue.Summary), 0o644)

	cwd := r.worktreeDir(issue.ID)
	if len(works) == 1 {
		cwd = works[0].wt
	}
	var prs []promptRepo
	for _, w := range works {
		pr := promptRepo{Slug: w.slug, Path: w.wt, Name: w.Name, Description: w.Description, Base: w.base(),
			Commits: runGit(ctx, w.wt, "log", "-20", "--format=%h %s", "origin/"+w.base()+"..HEAD").stdout, Conflicts: conflicts[w.slug]}
		// Instruções de cada projeto: inline quando é um repo só; com vários,
		// vão para um arquivo e o prompt leva só o caminho (a IA lê se for mexer nele).
		if t := strings.TrimSpace(w.Instructions); t != "" {
			if len(works) == 1 {
				pr.Instructions = t
			} else {
				f := filepath.Join(idir, "repos", w.slug+".md")
				os.MkdirAll(filepath.Dir(f), 0o755)
				os.WriteFile(f, []byte(t), 0o644)
				pr.InstructionsFile = f
			}
		}
		prs = append(prs, pr)
	}
	system := buildSystem(agent, skills, r.skillDir)
	prompt := buildPrompt(promptInput{
		Key: ws.Key, Issue: issue, Repos: prs, Root: cwd, Kind: run.Kind, Request: run.Request, Requester: requester,
		SummaryPath: summaryPath,
	})
	r.logEvent(ctx, run, "prompt", "<!-- system -->\n"+system+"\n\n<!-- prompt -->\n"+prompt)
	addDirs := []string{idir}
	if len(works) == 1 {
		addDirs = append(addDirs, r.worktreeDir(issue.ID))
	}
	for _, s := range skills {
		addDirs = append(addDirs, r.skillDir(s))
	}
	ac := r.agentCommand(agent, cwd, system, addDirs)
	desc := agent.Runtime
	if agent.Model != "" {
		desc += " " + agent.Model
	}
	r.logEvent(ctx, run, "info", fmt.Sprintf("%s · %s · %d skill(s) · %d repositório(s)", agent.Name, desc, len(skills), len(works)))

	o := r.spawn(ctx, run, ac, ac.preamble+prompt, cwd, agentEnv(
		"MULTICA_SUMMARY="+summaryPath,
		"MULTICA_ISSUE="+ref,
	))
	if o.result != nil {
		res.CostUSD, res.InputTokens, res.CachedTokens, res.OutputTokens = o.result.Cost, o.result.In, o.result.Cached, o.result.Out
	}

	// --- commit e publicação, repo a repo (inclusive em falha: nada se perde) ---
	label := ""
	if run.Kind != "initial" {
		label = " (" + map[string]string{"followup": "ajuste", "conflict": "conflito"}[run.Kind] + ")"
	}
	var shas, stats []string
	var cerr error
	for _, w := range works {
		sha, err := commitAll(ctx, w.wt, ref+" "+issue.Title+label, author, w.exclude)
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
		r.logEvent(ctx, run, "info", "O agente não atualizou o resumo; registrei um resumo automático.")
	}

	// --- resposta do agente vira comentário na issue ---
	if text := strings.TrimSpace(firstNonEmpty(finalText(o), o.lastText)); text != "" {
		if c, err := r.st.AddComment(ctx, store.Comment{IssueID: issue.ID, AgentID: &agent.ID, RunID: &run.ID, Kind: "agent", Body: text}); err == nil {
			r.hub.Publish(hub.Event{Type: "comment", WorkspaceID: issue.WorkspaceID, Data: c})
		}
	}

	switch {
	case cerr != nil:
		res.Error = cerr.Error()
	case o.exitErr != nil:
		res.Error = "o agente terminou com erro: " + o.exitErr.Error()
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
		r.logEvent(ctx, run, "error", w.slug+": não consegui publicar a branch no remoto: "+err.Error())
		return
	}
	r.logEvent(ctx, run, "info", w.slug+": branch publicada "+branch)
}

// hasCommits: a branch da issue tem commits além da base neste repositório.
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
	fmt.Fprintf(&b, "## Execução de %s (%s)\n_Gerado automaticamente: o agente não atualizou o resumo._\n\n", time.Now().Format("02/01 15:04"), run.Kind)
	if run.Request != "" {
		b.WriteString("**Pedido:** " + run.Request + "\n\n")
	}
	if text != "" {
		b.WriteString("**Resposta final:**\n" + clip(text, 1500) + "\n\n")
	}
	if stat != "" {
		b.WriteString("**Arquivos:**\n```\n" + stat + "\n```\n")
	}
	return b.String()
}
