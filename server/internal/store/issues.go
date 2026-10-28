package store

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
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
		from issue_repos ir join repos r on r.id = ir.repo_id where ir.issue_id = i.id), '[]'::jsonb) as repos,
	coalesce((select array_agg(a.user_id::text) from issue_approvals a where a.issue_id = i.id and a.stage = i.status), '{}') as approvals
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

// IssueQuery: uma página de issues (do quadro, da lista ou da busca). O quadro
// nunca carrega tudo: pede as primeiras de cada etapa e depois, etapa por
// etapa, mais um pedaço quando a pessoa rola.
type IssueQuery struct {
	Stage  string // vazio = todas as etapas (busca)
	Sort   string // manual | newest | oldest | updated | priority
	Offset int
	Limit  int
	Q      string // título, número (ex.: 42 ou LOJA-42) ou descrição
	Who    string // "" = todas | mine = criadas por UserID | id de um agente
	Label  string
	UserID string
}

// Ordens possíveis (todas com desempate pelo número, para a paginação ser estável).
var issueOrder = map[string]string{
	"manual":   "i.position, i.number desc",
	"newest":   "i.created_at desc, i.number desc",
	"oldest":   "i.created_at, i.number",
	"updated":  "i.updated_at desc, i.number desc",
	"priority": "case when i.priority = 0 then 9 else i.priority end, i.updated_at desc, i.number desc",
}

func (q IssueQuery) where(wsID string) (string, []any) {
	conds := []string{"i.workspace_id = $1"}
	args := []any{wsID}
	add := func(cond string, v any) {
		args = append(args, v)
		conds = append(conds, strings.ReplaceAll(cond, "?", fmt.Sprintf("$%d", len(args))))
	}
	if q.Stage != "" {
		add("i.status = ?", q.Stage)
	}
	if t := strings.TrimSpace(q.Q); t != "" {
		num := t
		if i := strings.LastIndex(t, "-"); i >= 0 {
			num = t[i+1:]
		}
		args = append(args, t, num)
		conds = append(conds, fmt.Sprintf("(i.title ilike '%%' || $%d || '%%' or i.number::text = $%d)", len(args)-1, len(args)))
	}
	switch {
	case q.Who == "mine" && q.UserID != "":
		add("i.created_by = ?::uuid", q.UserID)
	case q.Who != "" && q.Who != "mine":
		add("i.agent_id = ?::uuid", q.Who)
	}
	if q.Label != "" {
		add("?::uuid = any(i.label_ids)", q.Label)
	}
	return strings.Join(conds, " and "), args
}

// PageIssues: uma página na ordem pedida.
func (s *Store) PageIssues(ctx context.Context, wsID string, q IssueQuery) ([]Issue, error) {
	order, ok := issueOrder[q.Sort]
	if !ok {
		order = issueOrder["manual"]
	}
	if q.Limit <= 0 || q.Limit > 200 {
		q.Limit = 40
	}
	where, args := q.where(wsID)
	args = append(args, q.Limit, max(q.Offset, 0))
	return many[Issue](ctx, s, issueSelect+` where `+where+` order by `+order+
		fmt.Sprintf(` limit $%d offset $%d`, len(args)-1, len(args)), args...)
}

// StageCounts: quantas issues cada etapa tem com os mesmos filtros (o total da coluna).
func (s *Store) StageCounts(ctx context.Context, wsID string, q IssueQuery) (map[string]int, error) {
	q.Stage = ""
	where, args := q.where(wsID)
	rows, err := s.DB.Query(ctx, `select i.status, count(*) from issues i where `+where+` group by 1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var st string
		var n int
		rows.Scan(&st, &n)
		out[st] = n
	}
	return out, rows.Err()
}

// Working: issues com o agente trabalhando agora (o contador do quadro e do menu).
func (s *Store) Working(ctx context.Context, wsID string) int {
	var n int
	s.DB.QueryRow(ctx, `select count(distinct r.issue_id) from runs r join issues i on i.id = r.issue_id
		where i.workspace_id = $1 and r.status in ('queued', 'running')`, wsID).Scan(&n)
	return n
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
	AssigneeID  *string `json:"assigneeId"`
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
			branch, label_ids, skill_ids, created_by, all_repos, assignee_id)
		values($1,$2,$3,$4,$5,$6,
			coalesce((select min(position) from issues where workspace_id = $1 and status = $5), 0) - 1024,
			$7,$8,$9,$10,$11,$12,$13) returning id`,
		wsID, number, in.Title, in.Description, in.Status, in.Priority, in.AgentID,
		branch, nz(in.LabelIDs), nz(in.SkillIDs), nilIfEmpty(userID), len(in.RepoIDs) == 0, in.AssigneeID).Scan(&id)
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
	s.syncClosed(ctx, id, in.Status)
	is, err := s.Issue(ctx, id)
	if err == nil {
		s.DB.Exec(ctx, `insert into issue_stage_log(issue_id, workspace_id, stage) values($1, $2, $3)`, id, wsID, in.Status)
		s.Emit(ctx, Event{Kind: "created", IssueID: id, ActorID: nilIfEmpty(userID)})
	}
	return is, err
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Campos que o usuário pode alterar direto (o resto muda pelo fluxo de execução).
var editableIssueCols = map[string]string{
	"title": "title", "description": "description", "status": "status", "priority": "priority",
	"position": "position", "agentId": "agent_id", "labelIds": "label_ids", "skillIds": "skill_ids", "summary": "summary",
	"assigneeId": "assignee_id",
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
		if v == "" && (col == "agent_id" || col == "assignee_id") {
			v = nil
		}
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	before, _ := s.Issue(ctx, id)
	if _, err := s.DB.Exec(ctx, `update issues set `+strings.Join(sets, ", ")+` where id = $1`, args...); err != nil {
		return nil, err
	}
	is, err := s.Issue(ctx, id)
	if err == nil && before != nil {
		if _, ok := patch["status"]; ok {
			s.statusChanged(ctx, id, before.Status, is.Status)
		}
		if _, ok := patch["assigneeId"]; ok && is.AssigneeID != nil && (before.AssigneeID == nil || *before.AssigneeID != *is.AssigneeID) {
			s.Emit(ctx, Event{Kind: "assigned", IssueID: id})
		}
		if _, ok := patch["priority"]; ok && before.Priority != is.Priority {
			s.Emit(ctx, Event{Kind: "priority_changed", IssueID: id})
		}
	}
	return is, err
}

// SetIssueFields é usado pelo runner (status, resumo, merge) sem passar pelo filtro de campos editáveis.
func (s *Store) SetIssueStatus(ctx context.Context, id, status string) error {
	var from string
	err := s.DB.QueryRow(ctx, `update issues i set status = $2, updated_at = now()
		from (select status from issues where id = $1 for update) old
		where i.id = $1 returning old.status`, id, status).Scan(&from)
	if err == nil {
		s.statusChanged(ctx, id, from, status)
	}
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
		where i.workspace_id = $2 and i.all_repos and i.closed = '' on conflict do nothing`,
		repo.ID, repo.WorkspaceID, repo.DefaultBranch, repo.TargetBranch)
	return err
}

func (s *Store) DeleteIssue(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from issues where id = $1`, id)
	return err
}

// ---------- execuções ----------

func (s *Store) CreateRun(ctx context.Context, issue *Issue, agent *Agent, kind, request string, userID *string, holdStage bool) (*Run, error) {
	return one[Run](ctx, s, `insert into runs(issue_id, workspace_id, agent_id, agent_name, runtime, model, kind, request, created_by, hold_stage)
		values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
		issue.ID, issue.WorkspaceID, agent.ID, agent.Name, agent.Runtime, agent.Model, kind, request, userID, holdStage)
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

type MonthPoint struct {
	Month    string  `json:"month"`
	Created  int64   `json:"created"`
	Resolved int64   `json:"resolved"`
	CostUSD  float64 `json:"costUsd"`
	Runs     int64   `json:"runs"`
}

type IssueStats struct {
	Created         int64   `json:"created"`         // criadas no período
	Resolved        int64   `json:"resolved"`        // concluídas no período
	Open            int64   `json:"open"`            // abertas agora
	AvgResolveHours float64 `json:"avgResolveHours"` // criação → conclusão, das concluídas no período
	MedResolveHours float64 `json:"medResolveHours"` // mediana (não se deixa levar por uma issue esquecida)
}

// PriorityPoint: custo e tempo por prioridade da issue.
type PriorityPoint struct {
	Priority   int16   `json:"priority"`
	Issues     int64   `json:"issues"`
	Runs       int64   `json:"runs"`
	CostUSD    float64 `json:"costUsd"`
	AvgSeconds float64 `json:"avgSeconds"` // tempo médio de execução do agente
}

// StageTime: quanto tempo, em média, as issues ficam em cada etapa.
type StageTime struct {
	Stage    string  `json:"stage"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"` // o papel da etapa no fluxo (StageKind)
	Passes   int64   `json:"passes"`
	AvgHours float64 `json:"avgHours"`
	MedHours float64 `json:"medHours"`
}

type StatusCount struct {
	Status string `json:"status"`
	Count  int64  `json:"count"`
}

type ModelPoint struct {
	Runtime string `json:"runtime"`
	Model   string `json:"model"`
	Totals
}

type UserPoint struct {
	UserID  *string `json:"userId"`
	Name    string  `json:"name"`
	Runs    int64   `json:"runs"`
	CostUSD float64 `json:"costUsd"`
}

type TopIssue struct {
	ID      string  `json:"id"`
	Ref     string  `json:"ref"`
	Title   string  `json:"title"`
	Status  string  `json:"status"`
	CostUSD float64 `json:"costUsd"`
	Runs    int64   `json:"runs"`
}

type Analytics struct {
	Totals  Totals        `json:"totals"`
	Issues  IssueStats    `json:"issues"`
	Daily   []DayPoint    `json:"daily"`
	Monthly []MonthPoint  `json:"monthly"`
	Status  []StatusCount `json:"status"`
	Agents  []AgentPoint  `json:"agents"`
	Models  []ModelPoint  `json:"models"`
	Users   []UserPoint   `json:"users"`
	Top     []TopIssue    `json:"top"`
	// Desempenho: por prioridade, por quem criou a issue e por etapa.
	Priorities []PriorityPoint `json:"priorities"`
	Creators   []UserPoint     `json:"creators"`
	StageTimes []StageTime     `json:"stageTimes"`
	KindTimes  []KindTime      `json:"kindTimes"`
	People     []PersonStat    `json:"people"`
}

// KindTime: tempo somado por tipo de etapa (IA, esperando pessoas…), conforme as regras.
type KindTime struct {
	Kind     string  `json:"kind"`
	Hours    float64 `json:"hours"`
	Passes   int64   `json:"passes"`
	AvgHours float64 `json:"avgHours"`
}

// Tipos de etapa, tirados das regras de cada workspace (nada fixo por etapa):
//   - ai: o agente trabalha ali (destino de "agente começou" ou passo "rodar agente e esperar");
//   - people: esperando alguém responder (destino de "a IA precisa de você");
//   - approval: tem regra de aprovação;
//   - closed: tem regra "Encerrar a issue";
//   - queue: o resto (fila, trabalho manual).
func (s *Store) stageKinds(ctx context.Context, wsIDs []string) map[string]string {
	out := map[string]string{}
	rows, err := s.DB.Query(ctx, `select workspace_id::text, stage, trigger, action, config, conditions from rules
		where enabled and ($1::uuid[] is null or workspace_id = any($1::uuid[]))`, wsIDs)
	if err != nil {
		return out
	}
	defer rows.Close()
	rank := map[string]int{"ai": 4, "people": 3, "approval": 2, "closed": 1}
	set := func(ws, stage, kind string) {
		k := ws + "|" + stage
		if rank[kind] > rank[out[k]] {
			out[k] = kind
		}
	}
	for rows.Next() {
		var ws, stage, trigger, action string
		var cfg struct {
			To   string `json:"to"`
			Wait bool   `json:"wait"`
			Kind string `json:"kind"`
		}
		var cond Conditions
		var rawCfg, rawCond []byte
		if rows.Scan(&ws, &stage, &trigger, &action, &rawCfg, &rawCond) != nil {
			continue
		}
		json.Unmarshal(rawCfg, &cfg)
		json.Unmarshal(rawCond, &cond)
		switch {
		case trigger == "run_started" && action == "move":
			set(ws, cfg.To, "ai")
		case action == "run_agent" && cfg.Wait && stage != "":
			set(ws, stage, "ai")
		case trigger == "run_finished" && action == "move" && (slices.Contains(cond.Outcomes, "waiting") || slices.Contains(cond.Outcomes, "incomplete")):
			set(ws, cfg.To, "people")
		case trigger == "access" && action == "approval":
			set(ws, stage, "approval")
		case trigger == "access" && action == "close":
			set(ws, stage, "closed")
		}
	}
	return out
}

func kindKeys(kinds map[string]string, kind string) []string {
	keys := []string{}
	for k, v := range kinds {
		if v == kind {
			keys = append(keys, k)
		}
	}
	return keys
}

// PersonStat: o desempenho de cada pessoa no período.
type PersonStat struct {
	UserID       string  `json:"userId"`
	Name         string  `json:"name"`
	Created      int64   `json:"created"`      // issues que criou
	OpenAssigned int64   `json:"openAssigned"` // abertas com ela de responsável, agora
	Resolved     int64   `json:"resolved"`     // com ela de responsável, concluídas no período
	ResolveHours float64 `json:"resolveHours"` // média criação → conclusão dessas
	Comments     int64   `json:"comments"`
	Approvals    int64   `json:"approvals"`
	Runs         int64   `json:"runs"` // pedidos ao agente
	CostUSD      float64 `json:"costUsd"`
	ReplyHours   float64 `json:"replyHours"` // quanto as issues dela ficam esperando alguém (etapas "people")
}

const totalsCols = `coalesce(sum(cost_usd),0)::float8, coalesce(sum(input_tokens),0)::int8, coalesce(sum(cached_tokens),0)::int8,
	coalesce(sum(output_tokens),0)::int8, coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))),0)::float8,
	count(*), count(*) filter (where status = 'failed')`

// wsIDs nil = todos os workspaces; lista vazia = nenhum.
func (s *Store) Analytics(ctx context.Context, wsIDs []string, days int) (*Analytics, error) {
	since := time.Now().AddDate(0, 0, -days)
	where := `where created_at >= $1 and started_at is not null and ($2::uuid[] is null or workspace_id = any($2::uuid[]))`
	wsOnly := `($2::uuid[] is null or i.workspace_id = any($2::uuid[]))`
	out := &Analytics{Daily: []DayPoint{}, Monthly: []MonthPoint{}, Status: []StatusCount{}, Agents: []AgentPoint{},
		Models: []ModelPoint{}, Users: []UserPoint{}, Top: []TopIssue{}, Priorities: []PriorityPoint{}, Creators: []UserPoint{}, StageTimes: []StageTime{}, KindTimes: []KindTime{}, People: []PersonStat{}}
	t := &out.Totals
	if err := s.DB.QueryRow(ctx, `select `+totalsCols+` from runs `+where, since, wsIDs).
		Scan(&t.CostUSD, &t.InputTokens, &t.CachedTokens, &t.OutputTokens, &t.Seconds, &t.Runs, &t.Failed); err != nil {
		return nil, err
	}
	is := &out.Issues
	if err := s.DB.QueryRow(ctx, `select
			count(*) filter (where i.created_at >= $1),
			count(*) filter (where i.done_at >= $1),
			count(*) filter (where i.closed = ''),
			coalesce(avg(extract(epoch from (i.done_at - i.created_at)) / 3600) filter (where i.done_at >= $1), 0)::float8
		from issues i where `+wsOnly, since, wsIDs).Scan(&is.Created, &is.Resolved, &is.Open, &is.AvgResolveHours); err != nil {
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

	// Últimos 12 meses, sempre (independe do período escolhido).
	rows, err = s.DB.Query(ctx, `with m as (
			select generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') as month)
		select to_char(m.month, 'YYYY-MM'),
			(select count(*) from issues i where `+wsOnly+` and date_trunc('month', i.created_at) = m.month),
			(select count(*) from issues i where `+wsOnly+` and date_trunc('month', i.done_at) = m.month),
			(select coalesce(sum(r.cost_usd),0)::float8 from runs r where ($2::uuid[] is null or r.workspace_id = any($2::uuid[])) and date_trunc('month', r.created_at) = m.month),
			(select count(*) from runs r where ($2::uuid[] is null or r.workspace_id = any($2::uuid[])) and r.started_at is not null and date_trunc('month', r.created_at) = m.month)
		from m where $1::timestamptz is not null order by 1`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p MonthPoint
		if err := rows.Scan(&p.Month, &p.Created, &p.Resolved, &p.CostUSD, &p.Runs); err != nil {
			rows.Close()
			return nil, err
		}
		out.Monthly = append(out.Monthly, p)
	}
	rows.Close()

	rows, err = s.DB.Query(ctx, `select i.status, count(*) from issues i where `+wsOnly+`
		and (i.closed = '' or i.updated_at >= $1) group by 1`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p StatusCount
		rows.Scan(&p.Status, &p.Count)
		out.Status = append(out.Status, p)
	}
	rows.Close()

	rows, err = s.DB.Query(ctx, `select agent_id::text, max(agent_name), `+totalsCols+` from runs `+where+` group by agent_id order by 3 desc`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p AgentPoint
		if err := rows.Scan(&p.AgentID, &p.AgentName, &p.CostUSD, &p.InputTokens, &p.CachedTokens, &p.OutputTokens, &p.Seconds, &p.Runs, &p.Failed); err != nil {
			rows.Close()
			return nil, err
		}
		out.Agents = append(out.Agents, p)
	}
	rows.Close()

	rows, err = s.DB.Query(ctx, `select runtime, model, `+totalsCols+` from runs `+where+` group by 1, 2 order by 3 desc`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p ModelPoint
		if err := rows.Scan(&p.Runtime, &p.Model, &p.CostUSD, &p.InputTokens, &p.CachedTokens, &p.OutputTokens, &p.Seconds, &p.Runs, &p.Failed); err != nil {
			rows.Close()
			return nil, err
		}
		out.Models = append(out.Models, p)
	}
	rows.Close()

	rows, err = s.DB.Query(ctx, `select r.created_by::text, coalesce(max(u.name), 'Sistema'), count(*), coalesce(sum(r.cost_usd),0)::float8
		from runs r left join users u on u.id = r.created_by
		where r.created_at >= $1 and r.started_at is not null and ($2::uuid[] is null or r.workspace_id = any($2::uuid[]))
		group by r.created_by order by 3 desc limit 10`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p UserPoint
		rows.Scan(&p.UserID, &p.Name, &p.Runs, &p.CostUSD)
		out.Users = append(out.Users, p)
	}
	rows.Close()

	if err := s.performance(ctx, out, since, wsIDs); err != nil {
		return nil, err
	}

	rows, err = s.DB.Query(ctx, `select i.id::text, w.key || '-' || i.number, i.title, i.status, coalesce(sum(r.cost_usd),0)::float8, count(r.id)
		from issues i join workspaces w on w.id = i.workspace_id join runs r on r.issue_id = i.id
		where r.created_at >= $1 and `+wsOnly+` group by i.id, w.key order by 5 desc limit 8`, since, wsIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p TopIssue
		rows.Scan(&p.ID, &p.Ref, &p.Title, &p.Status, &p.CostUSD, &p.Runs)
		out.Top = append(out.Top, p)
	}
	return out, rows.Err()
}

// performance: custo por prioridade e por quem criou, tempo por etapa e mediana do ciclo.
func (s *Store) performance(ctx context.Context, out *Analytics, since time.Time, wsIDs []string) error {
	wsOnly := `($2::uuid[] is null or i.workspace_id = any($2::uuid[]))`
	rows, err := s.DB.Query(ctx, `select i.priority, count(distinct i.id), count(r.id), coalesce(sum(r.cost_usd),0)::float8,
		coalesce(avg(extract(epoch from (coalesce(r.ended_at, now()) - r.started_at))),0)::float8
		from runs r join issues i on i.id = r.issue_id
		where r.created_at >= $1 and r.started_at is not null and `+wsOnly+` group by 1 order by 1`, since, wsIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p PriorityPoint
		rows.Scan(&p.Priority, &p.Issues, &p.Runs, &p.CostUSD, &p.AvgSeconds)
		out.Priorities = append(out.Priorities, p)
	}
	rows.Close()

	rows, err = s.DB.Query(ctx, `select coalesce(i.created_by::text, ''), coalesce(max(u.name), 'Entrada externa'), count(r.id), coalesce(sum(r.cost_usd),0)::float8
		from runs r join issues i on i.id = r.issue_id left join users u on u.id = i.created_by
		where r.created_at >= $1 and r.started_at is not null and `+wsOnly+` group by i.created_by order by 4 desc limit 10`, since, wsIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p UserPoint
		rows.Scan(&p.UserID, &p.Name, &p.Runs, &p.CostUSD)
		out.Creators = append(out.Creators, p)
	}
	rows.Close()

	// Passagens encerradas no período, por etapa (mesmo id em vários workspaces vira uma
	// linha). Etapas que já foram removidas viram uma linha só, "Etapa removida".
	kinds := s.stageKinds(ctx, wsIDs)
	rows, err = s.DB.Query(ctx, `select case when st.id is null then '' else l.stage end as k,
		coalesce(max(st.name), 'Etapa removida'), count(*),
		avg(extract(epoch from (l.left_at - l.entered_at)))/3600,
		percentile_cont(0.5) within group (order by extract(epoch from (l.left_at - l.entered_at)))/3600,
		array_agg(distinct l.workspace_id::text)
		from issue_stage_log l left join stages st on st.workspace_id = l.workspace_id and st.id = l.stage
		where l.left_at >= $1 and ($2::uuid[] is null or l.workspace_id = any($2::uuid[]))
		group by k order by min(coalesce(st.position, 999))`, since, wsIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p StageTime
		var wss []string
		rows.Scan(&p.Stage, &p.Name, &p.Passes, &p.AvgHours, &p.MedHours, &wss)
		p.Kind = "queue"
		for _, ws := range wss {
			if k := kinds[ws+"|"+p.Stage]; k != "" {
				p.Kind = k
				break
			}
		}
		out.StageTimes = append(out.StageTimes, p)
	}
	rows.Close()

	// Tempo somado por tipo de etapa.
	rows, err = s.DB.Query(ctx, `select l.workspace_id::text || '|' || l.stage, count(*),
		coalesce(sum(extract(epoch from (l.left_at - l.entered_at))), 0)/3600
		from issue_stage_log l
		where l.left_at >= $1 and ($2::uuid[] is null or l.workspace_id = any($2::uuid[])) group by 1`, since, wsIDs)
	if err != nil {
		return err
	}
	byKind := map[string]*KindTime{}
	for rows.Next() {
		var key string
		var n int64
		var h float64
		rows.Scan(&key, &n, &h)
		kind := kinds[key]
		if kind == "" {
			kind = "queue"
		}
		if byKind[kind] == nil {
			byKind[kind] = &KindTime{Kind: kind}
		}
		byKind[kind].Passes += n
		byKind[kind].Hours += h
	}
	rows.Close()
	for _, k := range []string{"ai", "people", "approval", "queue"} {
		if kt := byKind[k]; kt != nil {
			kt.AvgHours = kt.Hours / float64(max(kt.Passes, 1))
			out.KindTimes = append(out.KindTimes, *kt)
		}
	}

	if err := s.DB.QueryRow(ctx, `select coalesce(percentile_cont(0.5) within group (order by extract(epoch from (i.done_at - i.created_at))), 0)/3600
		from issues i where i.done_at >= $1 and `+wsOnly, since, wsIDs).Scan(&out.Issues.MedResolveHours); err != nil {
		return err
	}
	return s.people(ctx, out, since, wsIDs, kindKeys(kinds, "people"))
}

// people: uma linha por pessoa com alguma atividade no período.
// waitKeys: "workspace|etapa" das etapas em que a issue espera alguém (tempo de resposta).
func (s *Store) people(ctx context.Context, out *Analytics, since time.Time, wsIDs []string, waitKeys []string) error {
	w := `($2::uuid[] is null or i.workspace_id = any($2::uuid[]))`
	rows, err := s.DB.Query(ctx, `select u.id::text, u.name,
		(select count(*) from issues i where i.created_by = u.id and i.created_at >= $1 and `+w+`),
		(select count(*) from issues i where i.assignee_id = u.id and i.closed = '' and `+w+`),
		(select count(*) from issues i where i.assignee_id = u.id and i.done_at >= $1 and `+w+`),
		coalesce((select avg(extract(epoch from (i.done_at - i.created_at))) from issues i where i.assignee_id = u.id and i.done_at >= $1 and `+w+`), 0)/3600,
		(select count(*) from comments c join issues i on i.id = c.issue_id where c.user_id = u.id and c.kind = 'comment' and c.created_at >= $1 and `+w+`),
		(select count(*) from issue_approvals a join issues i on i.id = a.issue_id where a.user_id = u.id and a.created_at >= $1 and `+w+`),
		(select count(*) from runs r join issues i on i.id = r.issue_id where r.created_by = u.id and r.created_at >= $1 and `+w+`),
		coalesce((select sum(r.cost_usd) from runs r join issues i on i.id = r.issue_id where r.created_by = u.id and r.created_at >= $1 and `+w+`), 0)::float8,
		coalesce((select avg(extract(epoch from (l.left_at - l.entered_at))) from issue_stage_log l join issues i on i.id = l.issue_id
			where (l.workspace_id::text || '|' || l.stage) = any($3) and l.left_at >= $1 and (i.assignee_id = u.id or i.created_by = u.id) and `+w+`), 0)/3600
		from users u order by u.name`, since, wsIDs, waitKeys)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var p PersonStat
		if err := rows.Scan(&p.UserID, &p.Name, &p.Created, &p.OpenAssigned, &p.Resolved, &p.ResolveHours, &p.Comments, &p.Approvals, &p.Runs, &p.CostUSD, &p.ReplyHours); err != nil {
			return err
		}
		if p.Created+p.OpenAssigned+p.Resolved+p.Comments+p.Approvals+p.Runs > 0 {
			out.People = append(out.People, p)
		}
	}
	return rows.Err()
}
