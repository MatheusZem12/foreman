package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"

	"multica/internal/store"
)

// Ações usadas pelas regras do fluxo (pacote automation).

func (r *Runner) SystemComment(ctx context.Context, issue *store.Issue, body string) {
	r.systemComment(ctx, issue, nil, body)
}

// IssueFolder é a pasta de trabalho da issue (worktrees) ou, se ainda não
// existir, a pasta de dados dela.
func (r *Runner) IssueFolder(issueID string) string {
	if fileExists(r.worktreeDir(issueID)) {
		return r.worktreeDir(issueID)
	}
	d := r.issueDir(issueID)
	os.MkdirAll(d, 0o755)
	return d
}

func (r *Runner) ReadmePath(issueID string) string {
	return r.issueDir(issueID) + "/README.md"
}

var reGitHub = regexp.MustCompile(`github\.com[:/]([^/]+)/([^/]+?)(\.git)?/?$`)

// gitHubRepo converte a URL do remoto em "dono/repo" (só GitHub).
func gitHubRepo(url string) (string, bool) {
	m := reGitHub.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return "", false
	}
	return m[1] + "/" + m[2], true
}

// OpenPRs abre um pull request (gh) por repositório alterado da issue.
// base vazio = branch de merge configurada na issue.
func (r *Runner) OpenPRs(ctx context.Context, issue *store.Issue, ref, base string, draft bool) ([]string, error) {
	scope, err := r.st.IssueRepos(ctx, issue.ID)
	if err != nil {
		return nil, err
	}
	body := strings.TrimSpace(issue.Summary)
	if body == "" {
		body = issue.Description
	}
	body += "\n\n---\nAberto pelo Multica (" + ref + ")."
	var urls []string
	var errs []error
	for _, sc := range scope {
		if !sc.IssueRepo.Changed || sc.IssueRepo.MergedInto != "" {
			continue
		}
		repo, ok := gitHubRepo(sc.URL)
		if !ok {
			errs = append(errs, fmt.Errorf("%s: só repositórios do GitHub", sc.Name))
			continue
		}
		target := base
		if target == "" {
			target = sc.IssueRepo.TargetBranch
		}
		args := []string{"pr", "create", "--repo", repo, "--head", issue.Branch, "--base", target, "--title", ref + " " + issue.Title, "--body", body}
		if draft {
			args = append(args, "--draft")
		}
		res := runCmd(ctx, "gh", args...)
		out := firstNonEmpty(res.stdout, res.stderr)
		switch {
		case res.ok:
			urls = append(urls, sc.Name+": "+lastLine(out))
		case strings.Contains(out, "already exists"):
			urls = append(urls, sc.Name+": já existia — "+lastLine(out))
		default:
			errs = append(errs, fmt.Errorf("%s: %s", sc.Name, lastLine(out)))
		}
	}
	if len(urls) == 0 && len(errs) == 0 {
		return nil, errors.New("nenhum repositório alterado")
	}
	return urls, errors.Join(errs...)
}

func lastLine(s string) string {
	l := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(l[len(l)-1])
}

// RunScript roda um script de regra na pasta da issue, com timeout.
// Devolve as últimas linhas da saída.
func (r *Runner) RunScript(ctx context.Context, issueID, script string, env []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", "-lc", script)
	cmd.Dir = r.IssueFolder(issueID)
	cmd.Env = append(agentEnv(r.cacheEnv()...), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	if ctx.Err() == context.DeadlineExceeded {
		err = errors.New("passou de 10 minutos")
	}
	return strings.Join(lines, "\n"), err
}
