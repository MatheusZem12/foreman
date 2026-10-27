package store

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Toda leitura de issue passa por aqui para trazer os campos calculados.
const issueSelect = `select i.*,
	(select r.id::text from runs r where r.issue_id = i.id and r.status in ('queued','running') order by r.created_at desc limit 1) as active_run,
	coalesce((select sum(r.cost_usd) from runs r where r.issue_id = i.id), 0)::float8 as cost_usd,
	coalesce((select jsonb_agg(jsonb_build_object('repoId', ir.repo_id, 'name', r.name, 'baseBranch', ir.base_branch,
		'targetBranch', ir.target_branch, 'changed', ir.changed, 'conflict', ir.conflict, 'mergedInto', ir.merged_into,
		'mergedSha', ir.merged_sha) order by r.name)
		from issue_repos ir join repos r on r.id = ir.repo_id where ir.issue_id = i.id), '[]'::jsonb) as repos
	from issues i`

// IssueRepo é um repositório no escopo da issue, com as branches dele e o
// estado do merge. changed = a IA alterou este repositório.
type IssueRepo struct {
	RepoID       string `json:"repoId"`
	Name         string `json:"name"`
	BaseBranch   string `json:"baseBranch"`
	TargetBranch string `json:"targetBranch"`
	Changed      bool   `json:"changed"`
	Conflict     bool   `json:"conflict"`
	MergedInto   string `json:"mergedInto"`
	MergedSHA    string `json:"mergedSha"`
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func Slugify(s string, max int) string {
	t := norm.NFD.String(strings.ToLower(s))
	t = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Mn, r) {
			return -1
		}
		return r
	}, t)
	t = strings.Trim(nonSlug.ReplaceAllString(t, "-"), "-")
	if len(t) > max {
		t = strings.TrimRight(t[:max], "-")
	}
	if t == "" {
		t = "issue"
	}
	return t
}

func (s *Store) ListIssues(ctx context.Context, wsID string) ([]Issue, error) {
	// Encerradas antigas ficam de fora da listagem padrão para manter o board leve.
	return many[Issue](ctx, s, issueSelect+` where i.workspace_id = $1
		and (i.status not in ('done','cancelled') or i.updated_at > now() - interval '30 days')
		order by i.position, i.number desc`, wsID)
}

func (s *Store) Issue(ctx context.Context, id string) (*Issue, error) {
	return one[Issue](ctx, s, issueSelect+` where i.id = $1`, id)
}

func (s *Store) IssueByNumber(ctx context.Context, wsID string, number int) (*Issue, error) {
	return one[Issue](ctx, s, issueSelect+` where i.workspace_id = $1 and i.number = $2`, wsID, number)
}

type NewIssue struct {
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Priority    int16   `json:"priority"`
	AgentID     *string `json:"agentId"`
	// Vazio = todos os repositórios do workspace (a IA escolhe onde mexer).
	RepoIDs  []string `json:"repoIds"`
	LabelIDs []string `json:"labelIds"`
	SkillIDs []string `json:"skillIds"`
}

func (s *Store) CreateIssue(ctx context.Context, wsID, userID string, in NewIssue) (*Issue, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var number int
	var key string
	if err := tx.QueryRow(ctx, `update workspaces set issue_seq = issue_seq + 1 where id = $1 returning issue_seq, key`, wsID).Scan(&number, &key); err != nil {
		return nil, err
	}
	branch := fmt.Sprintf("mx/%s-%d-%s", strings.ToLower(key), number, Slugify(in.Title, 32))
	var id string
	// Nova issue entra no topo da coluna.
	err = tx.QueryRow(ctx, `insert into issues(workspace_id, number, title, description, status, priority, position, agent_id,
			branch, label_ids, skill_ids, created_by, all_repos)
		values($1,$2,$3,$4,$5,$6,
			coalesce((select min(position) from issues where workspace_id = $1 and status = $5), 0) - 1024,
			$7,$8,$9,$10,$11,$12) returning id`,
		wsID, number, in.Title, in.Description, in.Status, in.Priority, in.AgentID,
		branch, nz(in.LabelIDs), nz(in.SkillIDs), userID, len(in.RepoIDs) == 0).Scan(&id)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `insert into issue_repos(issue_id, repo_id, base_branch, target_branch)
		select $1, r.id, r.default_branch, r.target_branch from repos r
		where r.workspace_id = $2 and (cardinality($3::uuid[]) = 0 or r.id = any($3::uuid[]))`, id, wsID, nz(in.RepoIDs)); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.Issue(ctx, id)
}

// Campos que o usuário pode alterar direto (o resto muda pelo fluxo de execução).
var editableIssueCols = map[string]string{
	"title": "title", "description": "description", "status": "status", "priority": "priority",
	"position": "position", "agentId": "agent_id", "labelIds": "label_ids", "skillIds": "skill_ids", "summary": "summary",
}

func (s *Store) PatchIssue(ctx context.Context, id string, patch map[string]any) (*Issue, error) {
	sets := []string{"updated_at = now()"}
	args := []any{id}
	for k, v := range patch {
		col, ok := editableIssueCols[k]
		if !ok {
			continue
		}
		if list, isList := v.([]any); isList {
			strs := make([]string, 0, len(list))
			for _, x := range list {
				strs = append(strs, fmt.Sprint(x))
			}
			v = strs
		}
		if f, isNum := v.(float64); isNum && col == "priority" {
			v = int16(f)
		}
		if v == "" && col == "agent_id" {
			v = nil
		}
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if _, err := s.DB.Exec(ctx, `update issues set `+strings.Join(sets, ", ")+` where id = $1`, args...); err != nil {
		return nil, err
	}
	return s.Issue(ctx, id)
}

// SetIssueFields é usado pelo runner (status, resumo, merge) sem passar pelo filtro de campos editáveis.
func (s *Store) SetIssueStatus(ctx context.Context, id, status string) error {
	_, err := s.DB.Exec(ctx, `update issues set status = $2, updated_at = now() where id = $1`, id, status)
	return err
}

func (s *Store) SetIssueSummary(ctx context.Context, id, summary string) error {
	_, err := s.DB.Exec(ctx, `update issues set summary = $2, updated_at = now() where id = $1`, id, summary)
	return err
}

// ---------- repositórios da issue ----------

// RepoScope é um repositório da issue com tudo o que o runner precisa.
type RepoScope struct {
	Repo
	IssueRepo IssueRepo
}

// SyncIssueRepos: issue em "todos os repositórios" ganha os que foram
// adicionados ao workspace depois que ela foi criada.
func (s *Store) SyncIssueRepos(ctx context.Context, issueID string) error {
	_, err := s.DB.Exec(ctx, `insert into issue_repos(issue_id, repo_id, base_branch, target_branch)
		select i.id, r.id, r.default_branch, r.target_branch from issues i join repos r on r.workspace_id = i.workspace_id
		where i.id = $1 and i.all_repos on conflict do nothing`, issueID)
	return err
}

func (s *Store) IssueRepos(ctx context.Context, issueID string) ([]RepoScope, error) {
	rows, err := s.DB.Query(ctx, `select r.id from issue_repos ir join repos r on r.id = ir.repo_id where ir.issue_id = $1 order by r.name`, issueID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	is, err := s.Issue(ctx, issueID)
	if err != nil {
		return nil, err
	}
	byID := map[string]IssueRepo{}
	for _, ir := range is.Repos {
		byID[ir.RepoID] = ir
	}
	out := []RepoScope{}
	for _, id := range ids {
		r, err := s.Repo(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, RepoScope{Repo: *r, IssueRepo: byID[id]})
	}
	return out, nil
}

// RepoChoice é a escolha de um repositório e suas branches para a issue.
type RepoChoice struct {
	RepoID       string `json:"repoId"`
	BaseBranch   string `json:"baseBranch"`
	TargetBranch string `json:"targetBranch"`
}

// SetIssueRepos troca o escopo. Repositórios que a IA já alterou não saem.
func (s *Store) SetIssueRepos(ctx context.Context, issueID string, all bool, choices []RepoChoice) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ids := make([]string, 0, len(choices))
	for _, c := range choices {
		ids = append(ids, c.RepoID)
	}
	if _, err := tx.Exec(ctx, `update issues set all_repos = $2, updated_at = now() where id = $1`, issueID, all); err != nil {
		return err
	}
	if !all {
		if _, err := tx.Exec(ctx, `delete from issue_repos where issue_id = $1 and not changed and not (repo_id = any($2::uuid[]))`, issueID, ids); err != nil {
			return err
		}
	}
	for _, c := range choices {
		if _, err := tx.Exec(ctx, `insert into issue_repos(issue_id, repo_id, base_branch, target_branch)
			select $1, r.id, coalesce(nullif($3, ''), r.default_branch), coalesce(nullif($4, ''), r.target_branch) from repos r
			where r.id = $2 and r.workspace_id = (select workspace_id from issues where id = $1)
			on conflict (issue_id, repo_id) do update set
				base_branch = case when issue_repos.changed then issue_repos.base_branch else excluded.base_branch end,
				target_branch = excluded.target_branch`, issueID, c.RepoID, c.BaseBranch, c.TargetBranch); err != nil {
			return err
		}
	}
	if all {
		if _, err := tx.Exec(ctx, `insert into issue_repos(issue_id, repo_id, base_branch, target_branch)
			select i.id, r.id, r.default_branch, r.target_branch from issues i join repos r on r.workspace_id = i.workspace_id
			where i.id = $1 on conflict do nothing`, issueID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) SetRepoChanged(ctx context.Context, issueID, repoID string, changed bool) error {
	_, err := s.DB.Exec(ctx, `update issue_repos set changed = $3 where issue_id = $1 and repo_id = $2`, issueID, repoID, changed)
	return err
}

func (s *Store) SetRepoConflict(ctx context.Context, issueID, repoID, target string, conflict bool) error {
	_, err := s.DB.Exec(ctx, `update issue_repos set conflict = $3, target_branch = coalesce(nullif($4, ''), target_branch)
		where issue_id = $1 and repo_id = $2`, issueID, repoID, conflict, target)
	return err
}

func (s *Store) SetRepoMerged(ctx context.Context, issueID, repoID, target, sha string) error {
	_, err := s.DB.Exec(ctx, `update issue_repos set merged_into = $3, merged_sha = $4, target_branch = $3, conflict = false
		where issue_id = $1 and repo_id = $2`, issueID, repoID, target, sha)
	return err
}

// Repositório novo entra nas issues abertas que trabalham com "todos".
func (s *Store) AddRepoToOpenIssues(ctx context.Context, repo *Repo) error {
	_, err := s.DB.Exec(ctx, `insert into issue_repos(issue_id, repo_id, base_branch, target_branch)
		select i.id, $1, $3, $4 from issues i
		where i.workspace_id = $2 and i.all_repos and i.status not in ('done', 'cancelled') on conflict do nothing`,
		repo.ID, repo.WorkspaceID, repo.DefaultBranch, repo.TargetBranch)
	return err
}

func (s *Store) DeleteIssue(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from issues where id = $1`, id)
	return err
}

// ---------- execuções ----------

func (s *Store) CreateRun(ctx context.Context, issue *Issue, agent *Agent, kind, request string, userID *string) (*Run, error) {
	return one[Run](ctx, s, `insert into runs(issue_id, workspace_id, agent_id, agent_name, runtime, model, kind, request, created_by)
		values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
		issue.ID, issue.WorkspaceID, agent.ID, agent.Name, agent.Runtime, agent.Model, kind, request, userID)
}

// ClaimNextRun pega a execução mais antiga da fila de forma atômica.
func (s *Store) ClaimNextRun(ctx context.Context) (*Run, error) {
	return one[Run](ctx, s, `update runs set status = 'running', started_at = now()
		where id = (select id from runs where status = 'queued' order by created_at limit 1 for update skip locked)
		returning *`)
}

func (s *Store) Run(ctx context.Context, id string) (*Run, error) {
	return one[Run](ctx, s, `select * from runs where id = $1`, id)
}

func (s *Store) ListRuns(ctx context.Context, issueID string) ([]Run, error) {
	return many[Run](ctx, s, `select * from runs where issue_id = $1 order by created_at`, issueID)
}

func (s *Store) ActiveRun(ctx context.Context, issueID string) (*Run, error) {
	return one[Run](ctx, s, `select * from runs where issue_id = $1 and status in ('queued','running') order by created_at desc limit 1`, issueID)
}

type RunResult struct {
	Status       string
	Error        string
	CostUSD      float64
	InputTokens  int64
	CachedTokens int64
	OutputTokens int64
	CommitSHA    string
}

func (s *Store) FinishRun(ctx context.Context, id string, r RunResult) (*Run, error) {
	return one[Run](ctx, s, `update runs set status=$2, error=$3, cost_usd=$4, input_tokens=$5, cached_tokens=$6, output_tokens=$7,
		commit_sha=$8, ended_at=now() where id=$1 returning *`,
		id, r.Status, r.Error, r.CostUSD, r.InputTokens, r.CachedTokens, r.OutputTokens, r.CommitSHA)
}

func (s *Store) CancelQueuedRun(ctx context.Context, id string) (bool, error) {
	tag, err := s.DB.Exec(ctx, `update runs set status = 'cancelled', error = 'Cancelada.', ended_at = now() where id = $1 and status = 'queued'`, id)
	return tag.RowsAffected() > 0, err
}

// RecoverInterrupted marca como falha o que estava rodando quando o servidor caiu.
func (s *Store) RecoverInterrupted(ctx context.Context) ([]string, error) {
	rows, err := s.DB.Query(ctx, `update runs set status = 'failed', error = 'Interrompida: o servidor reiniciou durante a execução.', ended_at = now()
		where status = 'running' returning issue_id::text`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) AddEvent(ctx context.Context, runID, kind, body string) (*RunEvent, error) {
	return one[RunEvent](ctx, s, `insert into run_events(run_id, kind, body) values($1,$2,$3) returning *`, runID, kind, body)
}

func (s *Store) Events(ctx context.Context, runID string) ([]RunEvent, error) {
	return many[RunEvent](ctx, s, `select * from run_events where run_id = $1 order by id`, runID)
}

// ---------- comentários ----------

func (s *Store) ListComments(ctx context.Context, issueID string) ([]Comment, error) {
	return many[Comment](ctx, s, `select * from comments where issue_id = $1 order by created_at`, issueID)
}

func (s *Store) AddComment(ctx context.Context, c Comment) (*Comment, error) {
	return one[Comment](ctx, s, `insert into comments(issue_id, user_id, agent_id, run_id, kind, body) values($1,$2,$3,$4,$5,$6) returning *`,
		c.IssueID, c.UserID, c.AgentID, c.RunID, c.Kind, c.Body)
}

// ---------- analytics ----------

type Totals struct {
	CostUSD      float64 `json:"costUsd"`
	InputTokens  int64   `json:"inputTokens"`
	CachedTokens int64   `json:"cachedTokens"`
	OutputTokens int64   `json:"outputTokens"`
	Seconds      float64 `json:"seconds"`
	Runs         int64   `json:"runs"`
	Failed       int64   `json:"failed"`
}

type DayPoint struct {
	Day string `json:"day"`
	Totals
}

type AgentPoint struct {
	AgentID   *string `json:"agentId"`
	AgentName string  `json:"agentName"`
	Totals
}

type Analytics struct {
	Totals Totals       `json:"totals"`
	Daily  []DayPoint   `json:"daily"`
	Agents []AgentPoint `json:"agents"`
}

const totalsCols = `coalesce(sum(cost_usd),0)::float8, coalesce(sum(input_tokens),0)::int8, coalesce(sum(cached_tokens),0)::int8,
	coalesce(sum(output_tokens),0)::int8, coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))),0)::float8,
	count(*), count(*) filter (where status = 'failed')`

// wsIDs nil = todos os workspaces (admin); lista vazia = nenhum.
func (s *Store) Analytics(ctx context.Context, wsIDs []string, days int) (*Analytics, error) {
	since := time.Now().AddDate(0, 0, -days)
	where := `where created_at >= $1 and started_at is not null and ($2::uuid[] is null or workspace_id = any($2::uuid[]))`
	out := &Analytics{Daily: []DayPoint{}, Agents: []AgentPoint{}}
	t := &out.Totals
	if err := s.DB.QueryRow(ctx, `select `+totalsCols+` from runs `+where, since, wsIDs).
		Scan(&t.CostUSD, &t.InputTokens, &t.CachedTokens, &t.OutputTokens, &t.Seconds, &t.Runs, &t.Failed); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(ctx, `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), `+totalsCols+` from runs `+where+` group by 1 order by 1`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p DayPoint
		if err := rows.Scan(&p.Day, &p.CostUSD, &p.InputTokens, &p.CachedTokens, &p.OutputTokens, &p.Seconds, &p.Runs, &p.Failed); err != nil {
			rows.Close()
			return nil, err
		}
		out.Daily = append(out.Daily, p)
	}
	rows.Close()
	rows, err = s.DB.Query(ctx, `select agent_id::text, max(agent_name), `+totalsCols+` from runs `+where+` group by agent_id order by 3 desc`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p AgentPoint
		if err := rows.Scan(&p.AgentID, &p.AgentName, &p.CostUSD, &p.InputTokens, &p.CachedTokens, &p.OutputTokens, &p.Seconds, &p.Runs, &p.Failed); err != nil {
			return nil, err
		}
		out.Agents = append(out.Agents, p)
	}
	return out, rows.Err()
}
