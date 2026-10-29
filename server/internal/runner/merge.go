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

	"foreman/internal/store"
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

// Merge does a --no-ff merge of the issue's branch into the target of each changed
// repository. First every merge happens locally, in temporary worktrees detached at
// origin/<target>; only if none conflicts are the targets published. That way a
// conflict in one repository doesn't leave the others half done. targets (repoID →
// branch) overrides the target.
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
		return nil, errors.New("no repository with changes to merge")
	}
	// Concluding (cleaning the unchanged repositories) only after releasing the locks
	// below: the defer registered earlier runs last.
	finished := false
	defer func() {
		if finished {
			r.cleanupUnchanged(ctx, issue)
			r.st.Emit(ctx, store.Event{Kind: "merged", IssueID: issue.ID})
			r.PublishIssue(ctx, issue.ID)
		}
	}()
	// Locks the repositories always in the same order (avoids deadlock between merges).
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

	who := "Foreman"
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
			return nil, fmt.Errorf("%s: target branch %q doesn't exist on the remote", w.Name, p.target)
		}
		// Pending changes made by hand in the worktree go in before the merge.
		if fileExists(w.wt) {
			if _, err := commitAll(ctx, w.wt, ref+" "+issue.Title+" (ajustes manuais)", "Foreman"); err != nil {
				return nil, fmt.Errorf("%s: %w", w.Name, err)
			}
		}
		source := issue.Branch
		if !refExists(ctx, p.repoDir, "refs/heads/"+source) {
			source = "origin/" + issue.Branch
			if !refExists(ctx, p.repoDir, "refs/remotes/"+source) {
				return nil, fmt.Errorf("%s: the issue's branch doesn't exist", w.Name)
			}
		}
		p.tmp = r.cfg.Path("tmp", "merge-"+issue.ID+"-"+w.ID)
		removeWorktree(ctx, p.repoDir, p.tmp)
		if _, err := mustGit(ctx, p.repoDir, "worktree", "add", "--detach", p.tmp, "origin/"+p.target); err != nil {
			p.tmp = ""
			return nil, fmt.Errorf("%s: %w", w.Name, err)
		}
		m := runGit(ctx, p.tmp, "-c", "user.name="+who, "-c", "user.email=foreman@localhost", "merge", "--no-ff", "-m", msg, source)
		if !m.ok {
			files := conflictedFiles(ctx, p.tmp)
			runGit(ctx, p.tmp, "merge", "--abort")
			if len(files) == 0 {
				return nil, fmt.Errorf("%s: merge failed: %s", w.Name, firstNonEmpty(m.stderr, m.stdout))
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
		r.systemComment(ctx, issue, nil, "Merge conflict; nothing was published.\n"+strings.Join(lines, "\n")+
			"\n\nUse **Resolve conflict with AI** or resolve it in the worktree.")
		r.PublishIssue(ctx, issue.ID)
		return out, nil
	}

	var done []string
	var pushErr error
	for _, p := range todo {
		if _, err := mustGit(ctx, p.tmp, "push", "origin", "HEAD:refs/heads/"+p.target); err != nil {
			pushErr = errors.Join(pushErr, fmt.Errorf("%s: merged locally, but pushing %s failed: %w", p.w.Name, p.target, err))
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

// cleanupUnchanged removes worktrees and local branches of the repositories the AI
// didn't change (they have nothing to publish).
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

// Discard cancels whatever is running and deletes the issue's worktrees and branches.
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

// RepoDiff is what the issue's branch introduced in a repository.
type RepoDiff struct {
	RepoID  string `json:"repoId"`
	Name    string `json:"name"`
	Stat    string `json:"stat"`
	Patch   string `json:"patch"`
	Pending bool   `json:"pending"`
	Merged  string `json:"merged"`
}

// Diff per repository (only the ones with changes).
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

// The remote's branches, for the interface's pickers.
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
		if b != "HEAD" && !(strings.HasPrefix(b, "fm/") || strings.HasPrefix(b, "mx/")) {
			list = append(list, b)
		}
	}
	return list, nil
}

// CheckRemote confirms the URL is a git repository reachable with the server's
// credentials (git ls-remote, without cloning).
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

// GitInfo shows how the server authenticates with git, for the settings screen.
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

// Runtimes tells whether the CLIs are installed on the server (and their version).
func (r *Runner) Runtimes(ctx context.Context) []map[string]any {
	var out []map[string]any
	for _, rt := range []struct{ name, bin string }{{"claude", r.cfg.ClaudeBin}, {"codex", r.cfg.CodexBin}} {
		res := runCmd(ctx, rt.bin, "--version")
		out = append(out, map[string]any{"runtime": rt.name, "bin": rt.bin, "installed": res.ok, "version": firstNonEmpty(res.stdout, res.stderr), "sandbox": r.sandboxed()})
	}
	return out
}
