package runner

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// No servidor cada repositório vira um clone bare em data/repos/<id>.git.
// As issues trabalham em worktrees desse clone e o resultado é publicado no
// remoto (push da branch da issue; no merge, push da branch de destino).

type gitResult struct {
	ok     bool
	stdout string
	stderr string
}

func gitEnv() []string {
	return append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
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

// Remove credenciais embutidas em URLs (https://token@host) das mensagens.
func redact(s string) string { return credInURL.ReplaceAllString(s, "${1}***@") }

func (r *Runner) repoDir(repoID string) string      { return r.cfg.Path("repos", repoID+".git") }
func (r *Runner) worktreeDir(issueID string) string { return r.cfg.Path("worktrees", issueID) }

// syncRepo garante o clone e atualiza as refs remotas.
func (r *Runner) syncRepo(ctx context.Context, repoID, url string) (string, error) {
	dir := r.repoDir(repoID)
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err != nil {
		os.MkdirAll(filepath.Dir(dir), 0o755)
		if _, err := mustGit(ctx, filepath.Dir(dir), "clone", "--bare", url, dir); err != nil {
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

func refExists(ctx context.Context, dir, ref string) bool {
	return runGit(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}").ok
}

// ensureWorktree cria (ou reaproveita) o worktree da issue. Ordem de origem da
// branch: local existente → remota existente (execução anterior já publicada) → base.
func (r *Runner) ensureWorktree(ctx context.Context, repoDir, wt, branch, base string) (created bool, err error) {
	if _, err := os.Stat(filepath.Join(wt, ".git")); err == nil {
		return false, nil
	}
	os.RemoveAll(wt)
	runGit(ctx, repoDir, "worktree", "prune")
	os.MkdirAll(filepath.Dir(wt), 0o755)
	switch {
	case refExists(ctx, repoDir, "refs/heads/"+branch):
		_, err = mustGit(ctx, repoDir, "worktree", "add", wt, branch)
	case refExists(ctx, repoDir, "refs/remotes/origin/"+branch):
		_, err = mustGit(ctx, repoDir, "worktree", "add", "-B", branch, wt, "origin/"+branch)
	default:
		if !refExists(ctx, repoDir, "refs/remotes/origin/"+base) {
			return false, fmt.Errorf("a branch base %q não existe no remoto", base)
		}
		_, err = mustGit(ctx, repoDir, "worktree", "add", "--no-track", "-B", branch, wt, "origin/"+base)
	}
	return err == nil, err
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

// Arquivos que ainda têm marcadores de conflito no disco.
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

// commitAll commita tudo o que ficou no worktree, menos os arquivos de
// ambiente que o próprio Multica escreveu. Se houver merge em andamento, só
// conclui quando não sobra marcador de conflito.
func commitAll(ctx context.Context, dir, message, author string, exclude []string) (string, error) {
	inMerge := mergeInProgress(ctx, dir)
	if inMerge {
		if left := filesWithMarkers(ctx, dir, conflictedFiles(ctx, dir)); len(left) > 0 {
			return "", fmt.Errorf("ainda há marcadores de conflito em: %s", strings.Join(left, ", "))
		}
	} else if !hasChanges(ctx, dir) {
		return "", nil
	}
	if _, err := mustGit(ctx, dir, "add", "-A"); err != nil {
		return "", err
	}
	if len(exclude) > 0 {
		runGit(ctx, dir, append([]string{"reset", "-q", "--"}, exclude...)...)
	}
	if !inMerge && runGit(ctx, dir, "diff", "--cached", "--quiet").ok {
		return "", nil
	}
	args := []string{"-c", "user.name=" + author, "-c", "user.email=multica@localhost", "commit", "-q", "--no-verify"}
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

type Diff struct {
	Stat      string `json:"stat"`
	Patch     string `json:"patch"`
	Pending   bool   `json:"pending"`
	Available bool   `json:"available"`
}

const maxPatch = 2 << 20 // 2 MB: diffs maiores são cortados na resposta

func worktreeDiff(ctx context.Context, wt, base string) Diff {
	ref := "origin/" + base
	stat := runGit(ctx, wt, "diff", "--stat", ref+"...HEAD").stdout
	patch := runGit(ctx, wt, "diff", ref+"...HEAD").stdout
	pending := runGit(ctx, wt, "diff", "HEAD").stdout
	if pending != "" {
		patch += "\n" + pending
	}
	if len(patch) > maxPatch {
		patch = patch[:maxPatch] + "\n… (diff cortado)"
	}
	return Diff{Stat: stat, Patch: patch, Pending: pending != "", Available: true}
}

func runCmd(ctx context.Context, bin string, args ...string) gitResult {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return gitResult{ok: err == nil, stdout: strings.TrimSpace(out.String()), stderr: strings.TrimSpace(errb.String())}
}
