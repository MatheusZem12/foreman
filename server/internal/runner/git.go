package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// On the server each repository becomes a bare clone in data/repos/<id>.git.
// Issues work in worktrees of that clone and the result is published to the
// remote (push of the issue's branch; on merge, push of the target branch).

type gitResult struct {
	ok     bool
	stdout string
	stderr string
}

func gitEnv() []string {
	return append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		// ext:: and fd:: run commands: a repository URL can't be a way into the server.
		"GIT_ALLOW_PROTOCOL=file:git:http:https:ssh",
		"GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
	)
}

func runGit(ctx context.Context, dir string, args ...string) gitResult {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return gitResult{ok: err == nil, stdout: strings.TrimRight(out.String(), "\n"), stderr: strings.TrimSpace(errb.String())}
}

func mustGit(ctx context.Context, dir string, args ...string) (string, error) {
	r := runGit(ctx, dir, args...)
	if !r.ok {
		msg := r.stderr
		if msg == "" {
			msg = r.stdout
		}
		return "", fmt.Errorf("git %s: %s", args[0], redact(msg))
	}
	return r.stdout, nil
}

var credInURL = regexp.MustCompile(`(https?://)[^/@\s]+@`)

// Removes credentials embedded in URLs (https://token@host) from messages.
func redact(s string) string { return credInURL.ReplaceAllString(s, "${1}***@") }

// MaskURL hides the credential of a repository URL. The server keeps the real one; people
// only ever see this.
func MaskURL(url string) string { return redact(url) }

func (r *Runner) repoDir(repoID string) string { return r.cfg.Path("repos", repoID+".git") }

// syncRepo garante o clone e atualiza as refs remotas.
func (r *Runner) syncRepo(ctx context.Context, repoID, url string) (string, error) {
	dir := r.repoDir(repoID)
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err != nil {
		os.MkdirAll(filepath.Dir(dir), 0o755)
		if _, err := mustGit(ctx, filepath.Dir(dir), "clone", "--bare", "--", url, dir); err != nil {
			os.RemoveAll(dir)
			return "", err
		}
		mustGit(ctx, dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	} else {
		mustGit(ctx, dir, "remote", "set-url", "origin", url)
	}
	if _, err := mustGit(ctx, dir, "fetch", "--prune", "origin"); err != nil {
		return "", err
	}
	return dir, nil
}

// defaultBranch is the remote's default branch (its HEAD), where issues start
// from when nobody picked another one.
func defaultBranch(ctx context.Context, dir string) (string, error) {
	runGit(ctx, dir, "remote", "set-head", "origin", "--auto")
	for _, ref := range []string{"refs/remotes/origin/HEAD", "HEAD"} {
		if b := strings.TrimPrefix(strings.TrimSpace(runGit(ctx, dir, "symbolic-ref", "--short", ref).stdout), "origin/"); b != "" && refExists(ctx, dir, "refs/remotes/origin/"+b) {
			return b, nil
		}
	}
	if runGit(ctx, dir, "for-each-ref", "--count=1", "refs/remotes/origin", "refs/heads").stdout == "" {
		return "", errors.New("the repository is empty: push a first commit so issues have somewhere to start from")
	}
	return "", errors.New("couldn't find the remote's default branch; choose the base on the issue")
}

func refExists(ctx context.Context, dir, ref string) bool {
	return runGit(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}").ok
}

// newWorktree checks the issue's branch out in a fresh worktree (in the run's temporary
// folder). The branch's origin, in order: existing local → existing remote (a previous run
// already published) → base. It says which one it was.
func (r *Runner) newWorktree(ctx context.Context, repoDir, wt, branch, base string) (from string, err error) {
	os.RemoveAll(wt)
	runGit(ctx, repoDir, "worktree", "prune")
	os.MkdirAll(filepath.Dir(wt), 0o755)
	switch {
	case refExists(ctx, repoDir, "refs/heads/"+branch):
		from = "branch " + branch
		_, err = mustGit(ctx, repoDir, "worktree", "add", wt, branch)
	case refExists(ctx, repoDir, "refs/remotes/origin/"+branch):
		from = "branch " + branch + " (remote)"
		_, err = mustGit(ctx, repoDir, "worktree", "add", "-B", branch, wt, "origin/"+branch)
	default:
		if !refExists(ctx, repoDir, "refs/remotes/origin/"+base) {
			return "", fmt.Errorf("base branch %q doesn't exist on the remote", base)
		}
		from = "new branch " + branch + " from " + base
		_, err = mustGit(ctx, repoDir, "worktree", "add", "--no-track", "-B", branch, wt, "origin/"+base)
	}
	return from, err
}

// syncRemoteBranch brings in what someone pushed to the issue's branch since the last run;
// otherwise the next publish (with the lease refreshed by the fetch) would overwrite it.
func syncRemoteBranch(ctx context.Context, wt, branch string) error {
	remote := "refs/remotes/origin/" + branch
	if !refExists(ctx, wt, remote) || mergeInProgress(ctx, wt) || runGit(ctx, wt, "merge-base", "--is-ancestor", remote, "HEAD").ok {
		return nil
	}
	if _, err := commitAll(ctx, wt, "Pending changes in the worktree", "Foreman"); err != nil {
		return err
	}
	m := runGit(ctx, wt, "-c", "user.name=Foreman", "-c", "user.email=foreman@localhost", "merge", "--no-edit", remote)
	if !m.ok {
		runGit(ctx, wt, "merge", "--abort")
		return fmt.Errorf("the branch %s changed on the remote and conflicts with the work here; resolve it on the branch and try again", branch)
	}
	return nil
}

func removeWorktree(ctx context.Context, repoDir, wt string) {
	runGit(ctx, repoDir, "worktree", "remove", "--force", wt)
	os.RemoveAll(wt)
	runGit(ctx, repoDir, "worktree", "prune")
}

func hasChanges(ctx context.Context, dir string) bool {
	return runGit(ctx, dir, "status", "--porcelain").stdout != ""
}

func mergeInProgress(ctx context.Context, dir string) bool {
	return runGit(ctx, dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").ok
}

func conflictedFiles(ctx context.Context, dir string) []string {
	return lines(runGit(ctx, dir, "diff", "--name-only", "--diff-filter=U").stdout)
}

// Files that still have conflict markers on disk.
func filesWithMarkers(ctx context.Context, dir string, files []string) []string {
	if len(files) == 0 {
		return nil
	}
	args := append([]string{"grep", "-lE", "^(<<<<<<<|>>>>>>>)( |$)", "--"}, files...)
	return lines(runGit(ctx, dir, args...).stdout)
}

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

// commitAll commits everything left in the worktree. If a merge is in progress,
// it only concludes when no conflict marker is left.
func commitAll(ctx context.Context, dir, message, author string) (string, error) {
	inMerge := mergeInProgress(ctx, dir)
	if inMerge {
		if left := filesWithMarkers(ctx, dir, conflictedFiles(ctx, dir)); len(left) > 0 {
			return "", fmt.Errorf("there are still conflict markers in: %s", strings.Join(left, ", "))
		}
	} else if !hasChanges(ctx, dir) {
		return "", nil
	}
	if _, err := mustGit(ctx, dir, "add", "-A"); err != nil {
		return "", err
	}
	if !inMerge && runGit(ctx, dir, "diff", "--cached", "--quiet").ok {
		return "", nil
	}
	args := []string{"-c", "user.name=" + author, "-c", "user.email=foreman@localhost", "commit", "-q", "--no-verify"}
	if inMerge {
		args = append(args, "--no-edit")
	} else {
		args = append(args, "-m", message)
	}
	if _, err := mustGit(ctx, dir, args...); err != nil {
		return "", err
	}
	return mustGit(ctx, dir, "rev-parse", "--short", "HEAD")
}

func pushBranch(ctx context.Context, dir, branch string) error {
	_, err := mustGit(ctx, dir, "push", "--force-with-lease", "origin", branch+":refs/heads/"+branch)
	return err
}

const maxPatch = 2 << 20 // 2 MB: larger diffs are cut in the response

func runCmd(ctx context.Context, bin string, args ...string) gitResult {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return gitResult{ok: err == nil, stdout: strings.TrimSpace(out.String()), stderr: strings.TrimSpace(errb.String())}
}
