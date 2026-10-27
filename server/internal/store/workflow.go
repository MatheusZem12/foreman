package store

import (
	"context"
	"encoding/json"
	"sort"
	"time"
)

// ---------- etapas ----------

// Stage é uma coluna do quadro. As do sistema têm comportamento próprio
// (A fazer inicia o agente, Concluída finaliza…); as personalizadas só
// existem para organizar e disparar regras.
type Stage struct {
	ID          string    `db:"id" json:"id"`
	WorkspaceID string    `db:"workspace_id" json:"workspaceId,omitempty"`
	Name        string    `db:"name" json:"name"`
	Color       string    `db:"color" json:"color"`
	Position    float64   `db:"position" json:"position"`
	CreatedAt   time.Time `db:"created_at" json:"-"`
	System      bool      `db:"-" json:"system"`
}

var SystemStages = []Stage{
	{ID: "backlog", Name: "Backlog", Color: "#8b8b94", Position: 10, System: true},
	{ID: "todo", Name: "A fazer", Color: "#d4d4d8", Position: 20, System: true},
	{ID: "in_progress", Name: "Em andamento", Color: "#f5b83d", Position: 30, System: true},
	{ID: "waiting", Name: "Aguardando você", Color: "#fb923c", Position: 40, System: true},
	{ID: "in_review", Name: "Em revisão", Color: "#4ade80", Position: 50, System: true},
	{ID: "blocked", Name: "Bloqueada", Color: "#f87171", Position: 60, System: true},
	{ID: "done", Name: "Concluída", Color: "#60a5fa", Position: 70, System: true},
	{ID: "cancelled", Name: "Cancelada", Color: "#71717a", Position: 80, System: true},
}

func SystemStage(id string) (Stage, bool) {
	for _, s := range SystemStages {
		if s.ID == id {
			return s, true
		}
	}
	return Stage{}, false
}

// Stages: as do sistema e as personalizadas do workspace, na ordem do quadro.
func (s *Store) Stages(ctx context.Context, wsID string) ([]Stage, error) {
	custom, err := many[Stage](ctx, s, `select * from stages where workspace_id = $1`, wsID)
	if err != nil {
		return nil, err
	}
	out := append(append([]Stage{}, SystemStages...), custom...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Position < out[j].Position })
	return out, nil
}

// StageName devolve o nome da etapa (do sistema ou personalizada).
func (s *Store) StageName(ctx context.Context, wsID, id string) string {
	if st, ok := SystemStage(id); ok {
		return st.Name
	}
	var name string
	if s.DB.QueryRow(ctx, `select name from stages where id::text = $1 and workspace_id = $2`, id, wsID).Scan(&name) != nil {
		return id
	}
	return name
}

func (s *Store) ValidStage(ctx context.Context, wsID, id string) bool {
	if _, ok := SystemStage(id); ok {
		return true
	}
	var ok bool
	s.DB.QueryRow(ctx, `select exists(select 1 from stages where id::text = $1 and workspace_id = $2)`, id, wsID).Scan(&ok)
	return ok
}

func (s *Store) Stage(ctx context.Context, id string) (*Stage, error) {
	return one[Stage](ctx, s, `select * from stages where id::text = $1`, id)
}

func (s *Store) SaveStage(ctx context.Context, st Stage) (*Stage, error) {
	if st.ID == "" {
		return one[Stage](ctx, s, `insert into stages(workspace_id, name, color, position) values($1,$2,$3,$4) returning *`,
			st.WorkspaceID, st.Name, st.Color, st.Position)
	}
	return one[Stage](ctx, s, `update stages set name=$2, color=$3, position=$4 where id=$1 returning *`, st.ID, st.Name, st.Color, st.Position)
}

// DeleteStage manda as issues da etapa para o Backlog e apaga as regras dela.
func (s *Store) DeleteStage(ctx context.Context, st *Stage) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `update issues set status = 'backlog', updated_at = now() where workspace_id = $1 and status = $2`, st.WorkspaceID, st.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from rules where workspace_id = $1 and stage = $2`, st.WorkspaceID, st.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from stages where id = $1`, st.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------- regras ----------

// Rule dispara uma ação quando uma issue entra na etapa.
type Rule struct {
	ID          string          `db:"id" json:"id"`
	WorkspaceID string          `db:"workspace_id" json:"workspaceId"`
	Stage       string          `db:"stage" json:"stage"`
	Action      string          `db:"action" json:"action"`
	Config      json.RawMessage `db:"config" json:"config"`
	Enabled     bool            `db:"enabled" json:"enabled"`
	Position    int             `db:"position" json:"position"`
	CreatedAt   time.Time       `db:"created_at" json:"createdAt"`
}

var RuleActions = map[string]bool{"notify": true, "webhook": true, "move": true, "run_agent": true, "open_pr": true, "merge": true, "script": true}

func (s *Store) ListRules(ctx context.Context, wsID string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where workspace_id = $1 order by stage, position, created_at`, wsID)
}

func (s *Store) RulesFor(ctx context.Context, wsID, stage string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where workspace_id = $1 and stage = $2 and enabled order by position, created_at`, wsID, stage)
}

func (s *Store) Rule(ctx context.Context, id string) (*Rule, error) {
	return one[Rule](ctx, s, `select * from rules where id::text = $1`, id)
}

func (s *Store) SaveRule(ctx context.Context, r Rule) (*Rule, error) {
	if len(r.Config) == 0 {
		r.Config = json.RawMessage("{}")
	}
	if r.ID == "" {
		return one[Rule](ctx, s, `insert into rules(workspace_id, stage, action, config, enabled, position)
			values($1,$2,$3,$4,$5,(select coalesce(max(position), -1) + 1 from rules where workspace_id = $1 and stage = $2)) returning *`,
			r.WorkspaceID, r.Stage, r.Action, r.Config, r.Enabled)
	}
	return one[Rule](ctx, s, `update rules set stage=$2, action=$3, config=$4, enabled=$5 where id=$1 returning *`,
		r.ID, r.Stage, r.Action, r.Config, r.Enabled)
}

func (s *Store) DeleteRule(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from rules where id = $1`, id)
	return err
}

// Regras com que todo workspace novo nasce (iguais às da migração 007).
func (s *Store) seedRules(ctx context.Context, wsID string) {
	s.DB.Exec(ctx, `insert into rules(workspace_id, stage, action, config, position) values
		($1, 'done', 'merge', '{}', 0), ($1, 'waiting', 'notify', '{"to": "requester"}', 0)`, wsID)
}

// ---------- mudança de etapa ----------

// StatusChange é avisado (pelo motor de automações) sempre que uma issue muda
// de etapa, venha a mudança da API, do runner ou de outra regra.
type StatusChange struct {
	IssueID string
	From    string
	To      string
	ActorID *string // quem moveu (nil = o próprio Multica)
}

type actorKey struct{}

// WithActor marca no contexto quem está fazendo a mudança.
func WithActor(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, actorKey{}, userID)
}

func actorOf(ctx context.Context) *string {
	if id, ok := ctx.Value(actorKey{}).(string); ok && id != "" {
		return &id
	}
	return nil
}

func (s *Store) statusChanged(ctx context.Context, id, from, to string) {
	if from != to && s.OnStatusChange != nil {
		s.OnStatusChange(StatusChange{IssueID: id, From: from, To: to, ActorID: actorOf(ctx)})
	}
}

// SetRunOutcome guarda o que a IA declarou ao terminar.
func (s *Store) SetRunOutcome(ctx context.Context, runID, outcome, note string) error {
	_, err := s.DB.Exec(ctx, `update runs set outcome = $2, outcome_note = $3 where id = $1`, runID, outcome, note)
	return err
}
