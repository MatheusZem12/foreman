// Package store concentra o acesso ao Postgres. Structs com tags `db` são
// lidas direto das linhas com pgx.RowToStructByName.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("não encontrado")

type Store struct {
	DB *pgxpool.Pool
	// OnEvent é chamado a cada evento de issue (motor de automações).
	OnEvent func(Event)
}

func New(pool *pgxpool.Pool) *Store { return &Store{DB: pool} }

// ---------- modelos ----------

type User struct {
	ID           string  `db:"id" json:"id"`
	Email        string  `db:"email" json:"email"`
	Name         string  `db:"name" json:"name"`
	PasswordHash string  `db:"password_hash" json:"-"`
	IsOwner      bool    `db:"is_owner" json:"isOwner"`
	RoleID       *string `db:"role_id" json:"roleId"`
	About        string  `db:"about" json:"about"`
	// Recebe e-mail de issue nova (quando o admin liga as notificações).
	EmailNotifications bool      `db:"email_notifications" json:"emailNotifications"`
	CreatedAt          time.Time `db:"created_at" json:"createdAt"`
	// Vindos de user_view (perfil resolvido).
	RoleName    string   `db:"role_name" json:"roleName"`
	Permissions []string `db:"permissions" json:"permissions"`
}

// Can diz se o usuário tem a permissão (o dono tem '*').
func (u *User) Can(perm string) bool {
	for _, p := range u.Permissions {
		if p == perm || p == "*" {
			return true
		}
	}
	return false
}

type Workspace struct {
	ID        string    `db:"id" json:"id"`
	Name      string    `db:"name" json:"name"`
	Key       string    `db:"key" json:"key"`
	IssueSeq  int       `db:"issue_seq" json:"-"`
	CreatedAt time.Time `db:"created_at" json:"createdAt"`
	// Entrada de issues por webhook: o token é segredo (só sai na rota de configuração).
}

type FileEntry struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type Repo struct {
	ID            string    `db:"id" json:"id"`
	WorkspaceID   string    `db:"workspace_id" json:"workspaceId"`
	Name          string    `db:"name" json:"name"`
	URL           string    `db:"url" json:"url"`
	DefaultBranch string    `db:"default_branch" json:"defaultBranch"`
	TargetBranch  string    `db:"target_branch" json:"targetBranch"`
	CreatedAt     time.Time `db:"created_at" json:"createdAt"`
	Description   string    `db:"description" json:"description"`
}

type Skill struct {
	ID          string      `db:"id" json:"id"`
	Slug        string      `db:"slug" json:"slug"`
	Name        string      `db:"name" json:"name"`
	Description string      `db:"description" json:"description"`
	Content     string      `db:"content" json:"content"`
	Files       []FileEntry `db:"files" json:"files"`
	Always      bool        `db:"always" json:"always"`
	UpdatedAt   time.Time   `db:"updated_at" json:"updatedAt"`
}

type Agent struct {
	ID           string    `db:"id" json:"id"`
	Name         string    `db:"name" json:"name"`
	Avatar       string    `db:"avatar" json:"avatar"`
	Runtime      string    `db:"runtime" json:"runtime"`
	Model        string    `db:"model" json:"model"`
	Effort       string    `db:"effort" json:"effort"`
	MaxBudgetUSD *float64  `db:"max_budget_usd" json:"maxBudgetUsd"`
	Instructions string    `db:"instructions" json:"instructions"`
	SkillIDs     []string  `db:"skill_ids" json:"skillIds"`
	ExtraArgs    string    `db:"extra_args" json:"extraArgs"`
	Archived     bool      `db:"archived" json:"archived"`
	CreatedAt    time.Time `db:"created_at" json:"createdAt"`
}

type Label struct {
	ID          string `db:"id" json:"id"`
	WorkspaceID string `db:"workspace_id" json:"workspaceId"`
	Name        string `db:"name" json:"name"`
	Color       string `db:"color" json:"color"`
}

type Issue struct {
	ID          string     `db:"id" json:"id"`
	WorkspaceID string     `db:"workspace_id" json:"workspaceId"`
	Number      int        `db:"number" json:"number"`
	Title       string     `db:"title" json:"title"`
	Description string     `db:"description" json:"description"`
	Status      string     `db:"status" json:"status"`
	Priority    int16      `db:"priority" json:"priority"`
	Position    float64    `db:"position" json:"position"`
	AgentID     *string    `db:"agent_id" json:"agentId"`
	Branch      string     `db:"branch" json:"branch"`
	LabelIDs    []string   `db:"label_ids" json:"labelIds"`
	SkillIDs    []string   `db:"skill_ids" json:"skillIds"`
	Summary     string     `db:"summary" json:"summary"`
	CreatedBy   *string    `db:"created_by" json:"createdBy"`
	CreatedAt   time.Time  `db:"created_at" json:"createdAt"`
	UpdatedAt   time.Time  `db:"updated_at" json:"updatedAt"`
	AllRepos    bool       `db:"all_repos" json:"allRepos"`
	DoneAt      *time.Time `db:"done_at" json:"doneAt"`
	Closed      string     `db:"closed" json:"closed"` // done | cancelled | vazio (aberta), pela regra "Encerrar" da etapa
	AssigneeID  *string    `db:"assignee_id" json:"assigneeId"`
	StageSince  time.Time  `db:"stage_entered_at" json:"stageSince"`
	// Calculados na listagem.
	Approvals []string    `db:"approvals" json:"approvals"` // quem já aprovou na etapa atual
	Repos     []IssueRepo `db:"repos" json:"repos"`
	ActiveRun *string     `db:"active_run" json:"activeRun"`
	CostUSD   float64     `db:"cost_usd" json:"costUsd"`
}

type Run struct {
	ID           string     `db:"id" json:"id"`
	IssueID      string     `db:"issue_id" json:"issueId"`
	WorkspaceID  string     `db:"workspace_id" json:"workspaceId"`
	AgentID      *string    `db:"agent_id" json:"agentId"`
	AgentName    string     `db:"agent_name" json:"agentName"`
	Runtime      string     `db:"runtime" json:"runtime"`
	Model        string     `db:"model" json:"model"`
	Kind         string     `db:"kind" json:"kind"`
	Request      string     `db:"request" json:"request"`
	Status       string     `db:"status" json:"status"`
	Error        string     `db:"error" json:"error"`
	CostUSD      float64    `db:"cost_usd" json:"costUsd"`
	InputTokens  int64      `db:"input_tokens" json:"inputTokens"`
	CachedTokens int64      `db:"cached_tokens" json:"cachedTokens"`
	OutputTokens int64      `db:"output_tokens" json:"outputTokens"`
	CommitSHA    string     `db:"commit_sha" json:"commitSha"`
	CreatedBy    *string    `db:"created_by" json:"createdBy"`
	CreatedAt    time.Time  `db:"created_at" json:"createdAt"`
	StartedAt    *time.Time `db:"started_at" json:"startedAt"`
	EndedAt      *time.Time `db:"ended_at" json:"endedAt"`
	Outcome      string     `db:"outcome" json:"outcome"`
	OutcomeNote  string     `db:"outcome_note" json:"outcomeNote"`
	// Pedida por um passo de etapa: a issue não muda de etapa por causa dela.
	HoldStage bool `db:"hold_stage" json:"holdStage"`
}

type RunEvent struct {
	ID        int64     `db:"id" json:"id"`
	RunID     string    `db:"run_id" json:"runId"`
	Kind      string    `db:"kind" json:"kind"`
	Body      string    `db:"body" json:"body"`
	CreatedAt time.Time `db:"created_at" json:"createdAt"`
}

type Comment struct {
	ID        string    `db:"id" json:"id"`
	IssueID   string    `db:"issue_id" json:"issueId"`
	UserID    *string   `db:"user_id" json:"userId"`
	AgentID   *string   `db:"agent_id" json:"agentId"`
	RunID     *string   `db:"run_id" json:"runId"`
	Kind      string    `db:"kind" json:"kind"`
	Body      string    `db:"body" json:"body"`
	CreatedAt time.Time `db:"created_at" json:"createdAt"`
}

// ---------- helpers ----------

func one[T any](ctx context.Context, s *Store, sql string, args ...any) (*T, error) {
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	v, err := pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[T])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return v, err
}

func many[T any](ctx context.Context, s *Store, sql string, args ...any) ([]T, error) {
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByName[T])
	if out == nil {
		out = []T{}
	}
	return out, err
}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func nzf(f []FileEntry) []FileEntry {
	if f == nil {
		return []FileEntry{}
	}
	return f
}

// ---------- usuários e sessões ----------

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.DB.QueryRow(ctx, `select count(*) from users`).Scan(&n)
	return n, err
}

// Leituras de usuário passam pela view para trazer perfil e permissões.
func (s *Store) CreateUser(ctx context.Context, email, name, hash string, owner bool, roleID *string) (*User, error) {
	var id string
	if err := s.DB.QueryRow(ctx, `insert into users(email, name, password_hash, is_owner, role_id) values(lower($1), $2, $3, $4, $5) returning id`,
		email, name, hash, owner, roleID).Scan(&id); err != nil {
		return nil, err
	}
	return s.UserByID(ctx, id)
}

func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return one[User](ctx, s, `select * from user_view where email = lower($1)`, email)
}

func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return one[User](ctx, s, `select * from user_view where id = $1`, id)
}

func (s *Store) UserBySession(ctx context.Context, token string) (*User, error) {
	return one[User](ctx, s, `select u.* from user_view u join sessions s on s.user_id = u.id where s.token = $1 and s.expires_at > now()`, token)
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	return many[User](ctx, s, `select * from user_view order by created_at`)
}

func (s *Store) UpdateUser(ctx context.Context, id, name, about string) (*User, error) {
	if _, err := s.DB.Exec(ctx, `update users set name = $2, about = $3 where id = $1`, id, name, about); err != nil {
		return nil, err
	}
	return s.UserByID(ctx, id)
}

func (s *Store) SetPassword(ctx context.Context, id, hash string) error {
	_, err := s.DB.Exec(ctx, `update users set password_hash = $2 where id = $1`, id, hash)
	return err
}

func (s *Store) DeleteUser(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from users where id = $1`, id)
	return err
}

func (s *Store) CreateSession(ctx context.Context, token, userID string, ttl time.Duration) error {
	_, err := s.DB.Exec(ctx, `insert into sessions(token, user_id, expires_at) values($1, $2, $3)`, token, userID, time.Now().Add(ttl))
	return err
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.DB.Exec(ctx, `delete from sessions where token = $1 or expires_at < now()`, token)
	return err
}

// ---------- workspaces ----------

func (s *Store) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	return many[Workspace](ctx, s, `select * from workspaces order by name`)
}

func (s *Store) WorkspaceByKey(ctx context.Context, key string) (*Workspace, error) {
	return one[Workspace](ctx, s, `select * from workspaces where key = upper($1)`, key)
}

func (s *Store) Workspace(ctx context.Context, id string) (*Workspace, error) {
	return one[Workspace](ctx, s, `select * from workspaces where id = $1`, id)
}

func (s *Store) CreateWorkspace(ctx context.Context, name, key string) (*Workspace, error) {
	ws, err := one[Workspace](ctx, s, `insert into workspaces(name, key) values($1, upper($2)) returning *`, name, key)
	if err == nil {
		s.seedWorkflow(ctx, ws.ID)
	}
	return ws, err
}

func (s *Store) UpdateWorkspace(ctx context.Context, id, name string) (*Workspace, error) {
	return one[Workspace](ctx, s, `update workspaces set name = $2 where id = $1 returning *`, id, name)
}

func (s *Store) DeleteWorkspace(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from workspaces where id = $1`, id)
	return err
}

// ---------- repositórios ----------

func (s *Store) ListRepos(ctx context.Context, wsID string) ([]Repo, error) {
	return many[Repo](ctx, s, `select * from repos where workspace_id = $1 order by name`, wsID)
}

func (s *Store) Repo(ctx context.Context, id string) (*Repo, error) {
	return one[Repo](ctx, s, `select * from repos where id = $1`, id)
}

func (s *Store) SaveRepo(ctx context.Context, r Repo) (*Repo, error) {
	if r.ID == "" {
		return one[Repo](ctx, s, `insert into repos(workspace_id, name, url, default_branch, target_branch, description)
			values($1,$2,$3,$4,$5,$6) returning *`,
			r.WorkspaceID, r.Name, r.URL, r.DefaultBranch, r.TargetBranch, r.Description)
	}
	return one[Repo](ctx, s, `update repos set name=$2, url=$3, default_branch=$4, target_branch=$5, description=$6
		where id = $1 returning *`,
		r.ID, r.Name, r.URL, r.DefaultBranch, r.TargetBranch, r.Description)
}

func (s *Store) DeleteRepo(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from repos where id = $1`, id)
	return err
}

// ---------- skills ----------

func (s *Store) ListSkills(ctx context.Context) ([]Skill, error) {
	return many[Skill](ctx, s, `select * from skills order by name`)
}

func (s *Store) Skill(ctx context.Context, id string) (*Skill, error) {
	return one[Skill](ctx, s, `select * from skills where id = $1`, id)
}

func (s *Store) SaveSkill(ctx context.Context, k Skill) (*Skill, error) {
	if k.ID == "" {
		return one[Skill](ctx, s, `insert into skills(slug, name, description, content, files, always) values($1,$2,$3,$4,$5,$6) returning *`,
			k.Slug, k.Name, k.Description, k.Content, nzf(k.Files), k.Always)
	}
	return one[Skill](ctx, s, `update skills set slug=$2, name=$3, description=$4, content=$5, files=$6, always=$7, updated_at=now() where id=$1 returning *`,
		k.ID, k.Slug, k.Name, k.Description, k.Content, nzf(k.Files), k.Always)
}

func (s *Store) DeleteSkill(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from skills where id = $1`, id)
	return err
}

// SkillsFor resolve as skills de uma execução: `always` + as do agente + as da issue.
func (s *Store) SkillsFor(ctx context.Context, ids []string) ([]Skill, error) {
	return many[Skill](ctx, s, `select * from skills where always or id = any($1) order by name`, nz(ids))
}

// ---------- agentes ----------

func (s *Store) ListAgents(ctx context.Context) ([]Agent, error) {
	return many[Agent](ctx, s, `select * from agents where not archived order by created_at`)
}

func (s *Store) Agent(ctx context.Context, id string) (*Agent, error) {
	return one[Agent](ctx, s, `select * from agents where id = $1`, id)
}

func (s *Store) SaveAgent(ctx context.Context, a Agent) (*Agent, error) {
	if a.ID == "" {
		return one[Agent](ctx, s, `insert into agents(name, avatar, runtime, model, effort, max_budget_usd, instructions, skill_ids, extra_args)
			values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
			a.Name, a.Avatar, a.Runtime, a.Model, a.Effort, a.MaxBudgetUSD, a.Instructions, nz(a.SkillIDs), a.ExtraArgs)
	}
	return one[Agent](ctx, s, `update agents set name=$2, avatar=$3, runtime=$4, model=$5, effort=$6, max_budget_usd=$7, instructions=$8, skill_ids=$9, extra_args=$10
		where id=$1 returning *`,
		a.ID, a.Name, a.Avatar, a.Runtime, a.Model, a.Effort, a.MaxBudgetUSD, a.Instructions, nz(a.SkillIDs), a.ExtraArgs)
}

// Arquiva em vez de apagar: o histórico de execuções e custos continua apontando para ele.
func (s *Store) ArchiveAgent(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `update agents set archived = true where id = $1`, id)
	return err
}

// ---------- labels ----------

func (s *Store) ListLabels(ctx context.Context, wsID string) ([]Label, error) {
	return many[Label](ctx, s, `select * from labels where workspace_id = $1 order by name`, wsID)
}

func (s *Store) CreateLabel(ctx context.Context, wsID, name, color string) (*Label, error) {
	return one[Label](ctx, s, `insert into labels(workspace_id, name, color) values($1,$2,$3)
		on conflict (workspace_id, name) do update set color = excluded.color returning *`, wsID, name, color)
}

func (s *Store) DeleteLabel(ctx context.Context, id string) error {
	if _, err := s.DB.Exec(ctx, `update issues set label_ids = array_remove(label_ids, $1::uuid) where $1::uuid = any(label_ids)`, id); err != nil {
		return err
	}
	_, err := s.DB.Exec(ctx, `delete from labels where id = $1`, id)
	return err
}

// SetSkillAgents deixa a skill no pacote exatamente destes agentes.
func (s *Store) SetSkillAgents(ctx context.Context, skillID string, agentIDs []string) error {
	_, err := s.DB.Exec(ctx, `update agents set skill_ids = case
			when id = any($2::uuid[]) then (select array_agg(distinct x) from unnest(array_append(skill_ids, $1)) x)
			else array_remove(skill_ids, $1) end
		where not archived`, skillID, nz(agentIDs))
	return err
}
