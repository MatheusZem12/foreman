package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"multica/internal/store"
)

type RepoMerge struct {
	RepoID   string   `json:"repoId"`
	Name     string   `json:"name"`
	Target   string   `json:"target"`
	Conflict bool     `json:"conflict,omitempty"`
	Files    []string `json:"files,omitempty"`
	SHA      string   `json:"sha,omitempty"`
}

type MergeResult struct {
	Conflict bool        `json:"conflict"`
	Repos    []RepoMerge `json:"repos"`
}

type pendingMerge struct {
	w       *repoWork
	repoDir string
	tmp     string
	target  string
	res     RepoMerge
}

// Merge faz merge --no-ff da branch da issue no destino de cada repositório
// alterado. Primeiro todos os merges acontecem localmente, em worktrees
// temporários destacados em origin/<destino>; só se nenhum der conflito os
// destinos são publicados. Assim um conflito em um repositório não deixa os
// outros pela metade. targets (repoID → branch) sobrescreve o destino.
func (r *Runner) Merge(ctx context.Context, issue *store.Issue, targets map[string]string, user *store.User) (*MergeResult, error) {
	if _, err := r.st.ActiveRun(ctx, issue.ID); err == nil {
		return nil, ErrBusy
	}
	ws, err := r.st.Workspace(ctx, issue.WorkspaceID)
	if err != nil {
		return nil, err
	}
	scope, err := r.st.IssueRepos(ctx, issue.ID)
	if err != nil {
		return nil, err
	}
	names := slugs(scope)
	var todo []*pendingMerge
	for i, sc := range scope {
		if !sc.IssueRepo.Changed || sc.IssueRepo.MergedInto != "" {
			continue
		}
		target := strings.TrimSpace(targets[sc.ID])
		if target == "" {
			target = sc.IssueRepo.TargetBranch
		}
		w := &repoWork{RepoScope: sc, slug: names[i], wt: filepath.Join(r.worktreeDir(issue.ID), names[i])}
		todo = append(todo, &pendingMerge{w: w, target: target, res: RepoMerge{RepoID: sc.ID, Name: sc.Name, Target: target}})
	}
	if len(todo) == 0 {
		return nil, errors.New("nenhum repositório com alterações para fazer merge")
	}
	// Concluir (limpar os repositórios não alterados) só depois de soltar as
	// travas abaixo: o defer registrado antes roda por último.
	finished := false
	defer func() {
		if finished {
			r.cleanupUnchanged(ctx, issue)
			r.st.Emit(ctx, store.Event{Kind: "merged", IssueID: issue.ID})
			r.PublishIssue(ctx, issue.ID)
		}
	}()
	// Trava os repositórios na mesma ordem sempre (evita deadlock entre merges).
	slices.SortFunc(todo, func(a, b *pendingMerge) int { return strings.Compare(a.w.ID, b.w.ID) })
	for _, p := range todo {
		defer r.lockRepo(p.w.ID)()
	}
	defer func() {
		for _, p := range todo {
			if p.tmp != "" {
				removeWorktree(context.Background(), p.repoDir, p.tmp)
			}
		}
	}()

	who := "Multica"
	if user != nil {
		who = user.Name
	}
	ref := fmt.Sprintf("%s-%d", ws.Key, issue.Number)
	msg := fmt.Sprintf("Merge %s: %s", ref, issue.Title)
	conflict := false
	for _, p := range todo {
		w := p.w
		if p.repoDir, err = r.syncRepo(ctx, w.ID, w.URL); err != nil {
			return nil, fmt.Errorf("%s: %w", w.Name, err)
		}
		if !refExists(ctx, p.repoDir, "refs/remotes/origin/"+p.target) {
			return nil, fmt.Errorf("%s: a branch de destino %q não existe no remoto", w.Name, p.target)
		}
		// Pendências feitas à mão no worktree entram antes do merge.
		if fileExists(w.wt) {
			if _, err := commitAll(ctx, w.wt, ref+" "+issue.Title+" (ajustes manuais)", "Multica"); err != nil {
				return nil, fmt.Errorf("%s: %w", w.Name, err)
			}
		}
		source := issue.Branch
		if !refExists(ctx, p.repoDir, "refs/heads/"+source) {
			source = "origin/" + issue.Branch
			if !refExists(ctx, p.repoDir, "refs/remotes/"+source) {
				return nil, fmt.Errorf("%s: a branch da issue não existe", w.Name)
			}
		}
		p.tmp = r.cfg.Path("tmp", "merge-"+issue.ID+"-"+w.ID)
		removeWorktree(ctx, p.repoDir, p.tmp)
		if _, err := mustGit(ctx, p.repoDir, "worktree", "add", "--detach", p.tmp, "origin/"+p.target); err != nil {
			p.tmp = ""
			return nil, fmt.Errorf("%s: %w", w.Name, err)
		}
		m := runGit(ctx, p.tmp, "-c", "user.name="+who, "-c", "user.email=multica@localhost", "merge", "--no-ff", "-m", msg, source)
		if !m.ok {
			files := conflictedFiles(ctx, p.tmp)
			runGit(ctx, p.tmp, "merge", "--abort")
			if len(files) == 0 {
				return nil, fmt.Errorf("%s: merge falhou: %s", w.Name, firstNonEmpty(m.stderr, m.stdout))
			}
			p.res.Conflict, p.res.Files, conflict = true, files, true
		}
	}

	out := &MergeResult{Conflict: conflict}
	if conflict {
		var lines []string
		for _, p := range todo {
			out.Repos = append(out.Repos, p.res)
			if p.res.Conflict {
				r.st.SetRepoConflict(ctx, issue.ID, p.w.ID, p.target, true)
				lines = append(lines, fmt.Sprintf("- **%s** → `%s`: %s", p.w.Name, p.target, strings.Join(p.res.Files, ", ")))
			}
		}
		r.st.Emit(ctx, store.Event{Kind: "merge_conflict", IssueID: issue.ID})
		r.systemComment(ctx, issue, nil, "Conflito no merge; nada foi publicado.\n"+strings.Join(lines, "\n")+
			"\n\nUse **Resolver conflito com IA** ou resolva no worktree.")
		r.PublishIssue(ctx, issue.ID)
		return out, nil
	}

	var done []string
	var pushErr error
	for _, p := range todo {
		if _, err := mustGit(ctx, p.tmp, "push", "origin", "HEAD:refs/heads/"+p.target); err != nil {
			pushErr = errors.Join(pushErr, fmt.Errorf("%s: merge feito localmente, mas o push de %s falhou: %w", p.w.Name, p.target, err))
			continue
		}
		p.res.SHA, _ = mustGit(ctx, p.tmp, "rev-parse", "--short", "HEAD")
		r.st.SetRepoMerged(ctx, issue.ID, p.w.ID, p.target, p.res.SHA)
		removeWorktree(ctx, p.repoDir, p.w.wt)
		runGit(ctx, p.repoDir, "branch", "-D", issue.Branch)
		runGit(ctx, p.repoDir, "push", "origin", "--delete", issue.Branch)
		done = append(done, fmt.Sprintf("**%s** → `%s` (%s)", p.w.Name, p.target, p.res.SHA))
		out.Repos = append(out.Repos, p.res)
	}
	if len(done) > 0 {
		r.systemComment(ctx, issue, nil, who+" fez merge: "+strings.Join(done, ", ")+".")
	}
	if pushErr != nil {
		r.PublishIssue(ctx, issue.ID)
		return out, pushErr
	}
	finished = true
	return out, nil
}

// cleanupUnchanged remove worktrees e branches locais dos repositórios que a
// IA não alterou (não têm nada para publicar).
func (r *Runner) cleanupUnchanged(ctx context.Context, issue *store.Issue) {
	scope, _ := r.st.IssueRepos(ctx, issue.ID)
	names := slugs(scope)
	for i, sc := range scope {
		if sc.IssueRepo.Changed && sc.IssueRepo.MergedInto == "" {
			continue
		}
		repoDir := r.repoDir(sc.ID)
		if !fileExists(repoDir) {
			continue
		}
		unlock := r.lockRepo(sc.ID)
		removeWorktree(ctx, repoDir, filepath.Join(r.worktreeDir(issue.ID), names[i]))
		runGit(ctx, repoDir, "branch", "-D", issue.Branch)
		unlock()
	}
	os.RemoveAll(r.worktreeDir(issue.ID))
}

// Discard cancela o que estiver rodando e apaga worktrees e branches da issue.
func (r *Runner) Discard(ctx context.Context, issue *store.Issue) error {
	if run, err := r.st.ActiveRun(ctx, issue.ID); err == nil {
		r.Cancel(ctx, run.ID)
	}
	scope, _ := r.st.IssueRepos(ctx, issue.ID)
	names := slugs(scope)
	for i, sc := range scope {
		repoDir := r.repoDir(sc.ID)
		if !fileExists(repoDir) || sc.IssueRepo.MergedInto != "" {
			continue
		}
		unlock := r.lockRepo(sc.ID)
		removeWorktree(ctx, repoDir, filepath.Join(r.worktreeDir(issue.ID), names[i]))
		runGit(ctx, repoDir, "branch", "-D", issue.Branch)
		if sc.IssueRepo.Changed {
			runGit(ctx, repoDir, "push", "origin", "--delete", issue.Branch)
		}
		r.st.SetRepoChanged(ctx, issue.ID, sc.ID, false)
		unlock()
	}
	os.RemoveAll(r.worktreeDir(issue.ID))
	os.RemoveAll(r.issueDir(issue.ID))
	return nil
}

// RepoDiff é o que a branch da issue introduziu num repositório.
type RepoDiff struct {
	RepoID  string `json:"repoId"`
	Name    string `json:"name"`
	Stat    string `json:"stat"`
	Patch   string `json:"patch"`
	Pending bool   `json:"pending"`
	Merged  string `json:"merged"`
}

// Diff por repositório (só os que têm alteração).
func (r *Runner) Diff(ctx context.Context, issue *store.Issue) []RepoDiff {
	scope, _ := r.st.IssueRepos(ctx, issue.ID)
	names := slugs(scope)
	out := []RepoDiff{}
	for i, sc := range scope {
		base := sc.IssueRepo.BaseBranch
		d := RepoDiff{RepoID: sc.ID, Name: sc.Name, Merged: sc.IssueRepo.MergedInto}
		wt := filepath.Join(r.worktreeDir(issue.ID), names[i])
		if fileExists(wt) {
			wd := worktreeDiff(ctx, wt, base)
			d.Stat, d.Patch, d.Pending = wd.Stat, wd.Patch, wd.Pending
		} else if repoDir := r.repoDir(sc.ID); fileExists(repoDir) && refExists(ctx, repoDir, "refs/remotes/origin/"+issue.Branch) {
			rng := "origin/" + base + "...origin/" + issue.Branch
			d.Stat = runGit(ctx, repoDir, "diff", "--stat", rng).stdout
			d.Patch = runGit(ctx, repoDir, "diff", rng).stdout
			if len(d.Patch) > maxPatch {
				d.Patch = d.Patch[:maxPatch] + "\n… (diff cortado)"
			}
		}
		if d.Patch != "" {
			out = append(out, d)
		}
	}
	return out
}

// Branches do remoto, para os seletores da interface.
func (r *Runner) Branches(ctx context.Context, repo *store.Repo) ([]string, error) {
	unlock := r.lockRepo(repo.ID)
	defer unlock()
	dir, err := r.syncRepo(ctx, repo.ID, repo.URL)
	if err != nil {
		return nil, err
	}
	out := runGit(ctx, dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:lstrip=3)", "refs/remotes/origin").stdout
	var list []string
	for _, b := range lines(out) {
		if b != "HEAD" && !strings.HasPrefix(b, "mx/") {
			list = append(list, b)
		}
	}
	return list, nil
}

// CheckRemote confirma que a URL é um repositório git acessível com as
// credenciais do servidor (git ls-remote, sem clonar).
func (r *Runner) CheckRemote(ctx context.Context, url string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res := runGit(ctx, os.TempDir(), "ls-remote", "--heads", url)
	if !res.ok {
		msg := redact(firstNonEmpty(res.stderr, res.stdout))
		if ctx.Err() != nil {
			msg = "tempo esgotado (o servidor pediu senha? configure SSH ou token)"
		}
		return errors.New(msg)
	}
	return nil
}

// GitInfo mostra como o servidor se autentica no git, para a tela de configuração.
func (r *Runner) GitInfo(ctx context.Context) map[string]any {
	home, _ := os.UserHomeDir()
	info := map[string]any{"version": runCmd(ctx, "git", "--version").stdout, "home": home}
	for _, k := range []string{"id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub"} {
		if b, err := os.ReadFile(filepath.Join(home, ".ssh", k)); err == nil {
			info["sshKey"] = strings.TrimSpace(string(b))
			break
		}
	}
	info["credentialHelper"] = runCmd(ctx, "git", "config", "--global", "credential.helper").stdout
	info["user"] = runCmd(ctx, "git", "config", "--global", "user.name").stdout
	gh := runCmd(ctx, "gh", "auth", "status")
	info["gh"] = gh.ok
	return info
}

// Runtimes informa se os CLIs estão instalados no servidor (e a versão).
func (r *Runner) Runtimes(ctx context.Context) []map[string]any {
	var out []map[string]any
	for _, rt := range []struct{ name, bin string }{{"claude", r.cfg.ClaudeBin}, {"codex", r.cfg.CodexBin}} {
		res := runCmd(ctx, rt.bin, "--version")
		out = append(out, map[string]any{"runtime": rt.name, "bin": rt.bin, "installed": res.ok, "version": firstNonEmpty(res.stdout, res.stderr), "sandbox": r.sandboxed()})
	}
	return out
}
