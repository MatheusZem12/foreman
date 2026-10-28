package store

import (
	"context"
	"encoding/json"
	"log"
	"slices"
	"time"
)

// ---------- etapas ----------

// Stage é uma coluna do quadro. Todo workspace tem as do sistema (com
// comportamento próprio: A fazer inicia o agente, Concluída finaliza…) e as
// suas; todas podem ser reordenadas e renomeadas. Quem pode, travas e
// aprovação são regras de acesso da etapa (trigger "access"); Policy é o
// resumo delas, montado na leitura.
type Stage struct {
	ID          string      `db:"id" json:"id"`
	WorkspaceID string      `db:"workspace_id" json:"workspaceId,omitempty"`
	Name        string      `db:"name" json:"name"`
	Color       string      `db:"color" json:"color"`
	Position    float64     `db:"position" json:"position"`
	CreatedAt   time.Time   `db:"created_at" json:"-"`
	Policy      StagePolicy `db:"-" json:"policy"`          // derivada das regras de acesso
	Parallel    bool        `db:"parallel" json:"parallel"` // ao lado da etapa anterior (mesma coluna no quadro)
}

// Who é um grupo de pessoas: perfis e/ou usuários. Vazio = sem restrição.
type Who struct {
	Roles []string `json:"roles,omitempty"`
	Users []string `json:"users,omitempty"`
}

func (w Who) Empty() bool { return len(w.Roles) == 0 && len(w.Users) == 0 }

// Has: a pessoa está listada no grupo (por usuário ou perfil), sem atalhos.
func (w Who) Has(u *User) bool {
	return u != nil && (slices.Contains(w.Users, u.ID) || (u.RoleID != nil && slices.Contains(w.Roles, *u.RoleID)))
}

// Includes: o dono sempre está incluído; grupo vazio inclui todo mundo.
func (w Who) Includes(u *User) bool {
	if u == nil {
		return false
	}
	if u.IsOwner || w.Empty() {
		return true
	}
	return slices.Contains(w.Users, u.ID) || (u.RoleID != nil && slices.Contains(w.Roles, *u.RoleID))
}

// StagePolicy é o que vale para as issues numa etapa: a soma das regras de
// acesso ativas dela.
type StagePolicy struct {
	Enter       Who      `json:"enter"`               // quem pode trazer issues para cá
	Act         Who      `json:"act"`                 // quem pode mexer nas issues daqui (editar, comentar, rodar, tirar)
	Locked      []string `json:"locked,omitempty"`    // campos que ninguém altera aqui: title, description, priority, labels, agent, repos, assignee
	Requires    []string `json:"requires,omitempty"`  // para entrar: agent, assignee, description, changes
	WIP         int      `json:"wip,omitempty"`       // máximo de issues ao mesmo tempo (0 = sem limite)
	Approvals   int      `json:"approvals,omitempty"` // aprovações necessárias (0 = etapa sem aprovação)
	ApproveTo   string   `json:"approveTo,omitempty"` // para onde vai quando aprovada
	Approvers   Who      `json:"approvers"`           // quem pode aprovar (vazio = quem tem issue.approve)
	Responsible Who      `json:"responsible"`         // responsáveis da etapa (notificações, "minhas")
	ReadOnly    bool     `json:"readOnly,omitempty"`  // entrou aqui, ninguém mexe mais (só o dono)
	Close       string   `json:"close,omitempty"`     // encerra a issue: done (resolvida) ou cancelled
}

// logStage fecha a passagem atual da issue e abre a da etapa nova.
func (s *Store) logStage(ctx context.Context, issueID, stage string) {
	s.DB.Exec(ctx, `update issue_stage_log set left_at = now() where issue_id = $1 and left_at is null`, issueID)
	s.DB.Exec(ctx, `insert into issue_stage_log(issue_id, workspace_id, stage) select id, workspace_id, $2 from issues where id = $1`, issueID, stage)
}

// EnabledNotifyRules: regras de e-mail ativas (todas), para avisar quando o envio está desligado.
func (s *Store) EnabledNotifyRules(ctx context.Context) int {
	var n int
	s.DB.QueryRow(ctx, `select count(*) from rules where action = 'notify' and enabled`).Scan(&n)
	return n
}

// Stages: todas as etapas do workspace, na ordem do quadro.
func (s *Store) Stages(ctx context.Context, wsID string) ([]Stage, error) {
	list, err := many[Stage](ctx, s, `select * from stages where workspace_id = $1 order by position, created_at`, wsID)
	if err != nil {
		return nil, err
	}
	pols, err := s.policies(ctx, wsID, "")
	if err != nil {
		return nil, err
	}
	for i := range list {
		list[i].Policy = pols[list[i].ID]
	}
	return list, nil
}

func (s *Store) StageOf(ctx context.Context, wsID, id string) (*Stage, error) {
	st, err := one[Stage](ctx, s, `select * from stages where workspace_id = $1 and id = $2`, wsID, id)
	if err != nil {
		return nil, err
	}
	pols, err := s.policies(ctx, wsID, id)
	if err != nil {
		return nil, err
	}
	st.Policy = pols[id]
	return st, nil
}

// AccessActions: o que uma regra de acesso pode dizer sobre a etapa.
var AccessActions = map[string]bool{
	"allow_act": true, "allow_enter": true, "read_only": true, "lock_fields": true,
	"require": true, "wip": true, "approval": true, "responsible": true, "close": true,
}

// AccessConfig: a config das regras de acesso.
type AccessConfig struct {
	Roles     []string `json:"roles,omitempty"`
	Users     []string `json:"users,omitempty"`
	Fields    []string `json:"fields,omitempty"`    // lock_fields
	Requires  []string `json:"requires,omitempty"`  // require
	WIP       int      `json:"wip,omitempty"`       // wip
	Approvals int      `json:"approvals,omitempty"` // approval: quantas pessoas diferentes
	To        string   `json:"to,omitempty"`        // approval: para onde vai
	Kind      string   `json:"kind,omitempty"`      // close: done | cancelled
}

func union(a, b []string) []string {
	for _, x := range b {
		if !slices.Contains(a, x) {
			a = append(a, x)
		}
	}
	return a
}

// policies soma as regras de acesso ativas por etapa (stage vazio = todas).
// Várias regras do mesmo tipo se somam: listas se juntam, o limite menor vale
// e a aprovação mais exigente vale.
func (s *Store) policies(ctx context.Context, wsID, stage string) (map[string]StagePolicy, error) {
	rules, err := many[Rule](ctx, s, `select * from rules where workspace_id = $1 and trigger = 'access' and enabled
		and ($2 = '' or stage = $2) order by position, created_at`, wsID, stage)
	if err != nil {
		return nil, err
	}
	out := map[string]StagePolicy{}
	for _, r := range rules {
		var c AccessConfig
		json.Unmarshal(r.Config, &c)
		p := out[r.Stage]
		who := func(w *Who) { w.Roles, w.Users = union(w.Roles, c.Roles), union(w.Users, c.Users) }
		switch r.Action {
		case "allow_act":
			who(&p.Act)
		case "allow_enter":
			who(&p.Enter)
		case "read_only":
			p.ReadOnly = true
		case "lock_fields":
			p.Locked = union(p.Locked, c.Fields)
		case "require":
			p.Requires = union(p.Requires, c.Requires)
		case "wip":
			if c.WIP > 0 && (p.WIP == 0 || c.WIP < p.WIP) {
				p.WIP = c.WIP
			}
		case "approval":
			if c.Approvals > p.Approvals {
				p.Approvals, p.ApproveTo = c.Approvals, c.To
			}
			who(&p.Approvers)
		case "responsible":
			who(&p.Responsible)
		case "close":
			p.Close = c.Kind
		}
		out[r.Stage] = p
	}
	return out, nil
}

// StageName devolve o nome da etapa no workspace.
func (s *Store) StageName(ctx context.Context, wsID, id string) string {
	if st, err := s.StageOf(ctx, wsID, id); err == nil {
		return st.Name
	}
	return id
}

func (s *Store) ValidStage(ctx context.Context, wsID, id string) bool {
	var ok bool
	s.DB.QueryRow(ctx, `select exists(select 1 from stages where workspace_id = $1 and id = $2)`, wsID, id).Scan(&ok)
	return ok
}

func (s *Store) SaveStage(ctx context.Context, st Stage) (*Stage, error) {
	if st.ID == "" {
		return one[Stage](ctx, s, `insert into stages(workspace_id, id, name, color, position, parallel)
			values($1, gen_random_uuid()::text, $2, $3, $4, $5) returning *`,
			st.WorkspaceID, st.Name, st.Color, st.Position, st.Parallel)
	}
	return one[Stage](ctx, s, `update stages set name=$3, color=$4, position=$5, parallel=$6 where workspace_id=$1 and id=$2 returning *`,
		st.WorkspaceID, st.ID, st.Name, st.Color, st.Position, st.Parallel)
}

// SetStageOrder grava a ordem das etapas (lista completa de ids).
func (s *Store) SetStageOrder(ctx context.Context, wsID string, ids []string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for i, id := range ids {
		if _, err := tx.Exec(ctx, `update stages set position = $3 where workspace_id = $1 and id = $2`, wsID, id, float64((i+1)*10)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// FirstStage: a primeira etapa do fluxo (para onde vai o que fica sem etapa).
func (s *Store) FirstStage(ctx context.Context, wsID string) string {
	var id string
	s.DB.QueryRow(ctx, `select id from stages where workspace_id = $1 order by position, created_at limit 1`, wsID).Scan(&id)
	return id
}

// DeleteStage manda as issues da etapa para a primeira das que sobram e apaga as regras dela.
func (s *Store) DeleteStage(ctx context.Context, st *Stage) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, q := range []string{
		`update issues set status = (select id from stages where workspace_id = $1 and id <> $2 order by position, created_at limit 1),
			updated_at = now(), stage_entered_at = now() where workspace_id = $1 and status = $2`,
		`delete from rules where workspace_id = $1 and stage = $2`,
		`delete from stages where workspace_id = $1 and id = $2`,
	} {
		if _, err := tx.Exec(ctx, q, st.WorkspaceID, st.ID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// OpenLoad: issues abertas por responsável (para distribuir trabalho).
func (s *Store) OpenLoad(ctx context.Context, wsID string) map[string]int {
	out := map[string]int{}
	rows, err := s.DB.Query(ctx, `select assignee_id::text, count(*) from issues
		where workspace_id = $1 and assignee_id is not null and closed = '' group by 1`, wsID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		rows.Scan(&id, &n)
		out[id] = n
	}
	return out
}

// CountInStage: issues numa etapa (para o limite de WIP).
func (s *Store) CountInStage(ctx context.Context, wsID, stage string) int {
	var n int
	s.DB.QueryRow(ctx, `select count(*) from issues where workspace_id = $1 and status = $2`, wsID, stage).Scan(&n)
	return n
}

// ---------- regras ----------

// Rule: quando o gatilho acontece (e as condições batem), faz a ação.
type Rule struct {
	ID          string          `db:"id" json:"id"`
	WorkspaceID string          `db:"workspace_id" json:"workspaceId"`
	Stage       string          `db:"stage" json:"stage"` // etapa do gatilho (enter/leave/stale); vazio nos demais
	Action      string          `db:"action" json:"action"`
	Config      json.RawMessage `db:"config" json:"config"`
	Enabled     bool            `db:"enabled" json:"enabled"`
	Position    int             `db:"position" json:"position"`
	CreatedAt   time.Time       `db:"created_at" json:"createdAt"`
	Trigger     string          `db:"trigger" json:"trigger"`
	Conditions  json.RawMessage `db:"conditions" json:"conditions"`
}

// Gatilhos. enter/leave/stale pedem etapa.
var RuleTriggers = map[string]bool{
	"enter": true, "leave": true, "stale": true, "access": true, // etapa
	"created": true, "commented": true, "run_started": true, "run_finished": true, "merged": true, "merge_conflict": true,
	"cost_over": true, "assigned": true, "priority_changed": true,
}

func TriggerNeedsStage(t string) bool {
	return t == "enter" || t == "leave" || t == "stale" || t == "access"
}

var RuleActions = map[string]bool{
	"notify": true, "webhook": true, "move": true, "run_agent": true, "open_pr": true, "merge": true, "script": true,
	"set_agent": true, "set_priority": true, "add_label": true, "assign": true, "comment": true, "stop_agent": true,
}

// Conditions: filtros que a issue precisa atender para a regra disparar.
type Conditions struct {
	Priorities []int    `json:"priorities,omitempty"` // 1 urgente … 4 baixa, 0 sem
	Labels     []string `json:"labels,omitempty"`     // tem alguma destas
	Agents     []string `json:"agents,omitempty"`     // agente da issue é um destes
	Outcomes   []string `json:"outcomes,omitempty"`   // run_finished: done, waiting, incomplete, failed, cancelled
	Stages     []string `json:"stages,omitempty"`     // a issue está numa destas etapas (gatilhos sem etapa)
	Hours      float64  `json:"hours,omitempty"`      // stale: horas paradas na etapa
	Cost       float64  `json:"cost,omitempty"`       // cost_over: US$
	ActorRoles []string `json:"actorRoles,omitempty"` // quem causou o evento tem um destes perfis
}

func (s *Store) ListRules(ctx context.Context, wsID string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where workspace_id = $1 order by trigger, stage, position, created_at`, wsID)
}

// RulesFor: regras ativas de um gatilho (e etapa, quando o gatilho tem etapa).
func (s *Store) RulesFor(ctx context.Context, wsID, trigger, stage string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where workspace_id = $1 and trigger = $2 and stage = $3 and enabled
		order by position, created_at`, wsID, trigger, stage)
}

// RulesByTrigger: regras ativas de um gatilho em todos os workspaces (varredura por tempo).
func (s *Store) RulesByTrigger(ctx context.Context, trigger string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where trigger = $1 and enabled`, trigger)
}

func (s *Store) Rule(ctx context.Context, id string) (*Rule, error) {
	return one[Rule](ctx, s, `select * from rules where id::text = $1`, id)
}

func (s *Store) SaveRule(ctx context.Context, r Rule) (*Rule, error) {
	if len(r.Config) == 0 {
		r.Config = json.RawMessage("{}")
	}
	if len(r.Conditions) == 0 {
		r.Conditions = json.RawMessage("{}")
	}
	if r.ID == "" {
		return one[Rule](ctx, s, `insert into rules(workspace_id, stage, action, config, enabled, trigger, conditions, position)
			values($1,$2,$3,$4,$5,$6,$7,(select coalesce(max(position), -1) + 1 from rules where workspace_id = $1 and stage = $2)) returning *`,
			r.WorkspaceID, r.Stage, r.Action, r.Config, r.Enabled, r.Trigger, r.Conditions)
	}
	return one[Rule](ctx, s, `update rules set stage=$2, action=$3, config=$4, enabled=$5, trigger=$6, conditions=$7 where id=$1 returning *`,
		r.ID, r.Stage, r.Action, r.Config, r.Enabled, r.Trigger, r.Conditions)
}

// SetRuleOrder grava a ordem em que as regras rodam (ids do mesmo workspace).
func (s *Store) SetRuleOrder(ctx context.Context, wsID string, ids []string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for i, id := range ids {
		if _, err := tx.Exec(ctx, `update rules set position = $3 where workspace_id = $1 and id::text = $2`, wsID, id, i); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) DeleteRule(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from rules where id = $1`, id)
	return err
}

// MarkFired registra o disparo único de uma regra numa issue; false se já disparou.
func (s *Store) MarkFired(ctx context.Context, ruleID, issueID string) bool {
	tag, err := s.DB.Exec(ctx, `insert into rule_fires(rule_id, issue_id) values($1, $2) on conflict do nothing`, ruleID, issueID)
	return err == nil && tag.RowsAffected() > 0
}

// StaleIssues: issues paradas na etapa há mais de `hours` horas.
func (s *Store) StaleIssues(ctx context.Context, wsID, stage string, hours float64) ([]Issue, error) {
	return many[Issue](ctx, s, issueSelect+` where i.workspace_id = $1 and i.status = $2
		and i.stage_entered_at < now() - make_interval(secs => $3)`, wsID, stage, hours*3600)
}

// CostlyIssues: issues abertas cujo custo somado passou de usd.
func (s *Store) CostlyIssues(ctx context.Context, wsID string, usd float64) ([]Issue, error) {
	return many[Issue](ctx, s, issueSelect+` where i.workspace_id = $1 and i.closed = ''
		and (select coalesce(sum(cost_usd), 0) from runs where issue_id = i.id) > $2`, wsID, usd)
}

// seedWorkflow: o fluxo padrão (etapas e regras) com que todo workspace
// nasce. Fica no banco (função seed_workflow, migração 016) e é todo editável.
func (s *Store) seedWorkflow(ctx context.Context, wsID string) {
	if _, err := s.DB.Exec(ctx, `select seed_workflow($1)`, wsID); err != nil {
		log.Printf("fluxo padrão de %s: %v", wsID, err)
	}
}

// ReplaceWorkflow troca etapas e regras do workspace pelas informadas (duplicação).
// Issues em etapas que deixam de existir vão para a primeira etapa.
func (s *Store) ReplaceWorkflow(ctx context.Context, wsID string, stages []Stage, rules []Rule) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `delete from rules where workspace_id = $1`, wsID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from stages where workspace_id = $1`, wsID); err != nil {
		return err
	}
	ids := []string{}
	for _, st := range stages {
		ids = append(ids, st.ID)
		if _, err := tx.Exec(ctx, `insert into stages(workspace_id, id, name, color, position, parallel) values($1,$2,$3,$4,$5,$6)`,
			wsID, st.ID, st.Name, st.Color, st.Position, st.Parallel); err != nil {
			return err
		}
	}
	for _, r := range rules {
		if _, err := tx.Exec(ctx, `insert into rules(workspace_id, stage, action, config, enabled, position, trigger, conditions)
			values($1,$2,$3,$4,$5,$6,$7,$8)`, wsID, r.Stage, r.Action, r.Config, r.Enabled, r.Position, r.Trigger, r.Conditions); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `update issues set status = $3, stage_entered_at = now() where workspace_id = $1 and not (status = any($2))`, wsID, ids, ids[0]); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------- aprovações ----------

// Approve registra a aprovação da pessoa na etapa atual; devolve o total.
func (s *Store) Approve(ctx context.Context, issueID, stage, userID string) (int, error) {
	if _, err := s.DB.Exec(ctx, `insert into issue_approvals(issue_id, stage, user_id) values($1,$2,$3) on conflict do nothing`, issueID, stage, userID); err != nil {
		return 0, err
	}
	var n int
	err := s.DB.QueryRow(ctx, `select count(*) from issue_approvals where issue_id = $1 and stage = $2`, issueID, stage).Scan(&n)
	return n, err
}

// ---------- entrada por webhook ----------

func (s *Store) WorkspaceByIntake(ctx context.Context, token string) (*Workspace, error) {
	return one[Workspace](ctx, s, `select * from workspaces where intake_token = $1`, token)
}

func (s *Store) SetIntake(ctx context.Context, wsID string, token *string, stage string) (*Workspace, error) {
	return one[Workspace](ctx, s, `update workspaces set intake_token = $2, intake_stage = $3 where id = $1 returning *`, wsID, token, stage)
}

// ---------- membros com acesso ----------

// WorkspaceUserIDs: quem tem acesso ao workspace (vínculo ou "ver todos").
func (s *Store) WorkspaceUserIDs(ctx context.Context, wsID string) (map[string]bool, error) {
	ms, err := s.ListMembers(ctx, wsID)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, m := range ms {
		out[m.ID] = true
	}
	return out, nil
}

// ---------- mudanças de etapa e eventos ----------

// Event é avisado ao motor de automações: mudança de etapa, issue criada,
// comentário, execução terminada, responsável ou prioridade trocados.
type Event struct {
	Kind    string // stage | created | commented | run_started | run_finished | merged | merge_conflict | assigned | priority_changed
	IssueID string
	From    string // stage: etapa de onde saiu
	To      string // stage: etapa para onde foi
	ActorID *string
	Outcome string // run_finished: done | waiting | incomplete | failed | cancelled
}

// StatusChange é o evento de mudança de etapa (mantido para o runner/motor).
type StatusChange = Event

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

func (s *Store) Emit(ctx context.Context, ev Event) {
	if ev.ActorID == nil {
		ev.ActorID = actorOf(ctx)
	}
	if s.OnEvent != nil {
		s.OnEvent(ev)
	}
}

func (s *Store) statusChanged(ctx context.Context, id, from, to string) {
	if from != to {
		s.syncClosed(ctx, id, to)
		s.DB.Exec(ctx, `update issues set stage_entered_at = now() where id = $1`, id)
		s.logStage(ctx, id, to)
		// "parada há X horas" volta a valer a cada etapa nova.
		s.DB.Exec(ctx, `delete from rule_fires f using rules r where f.rule_id = r.id and r.trigger = 'stale' and f.issue_id = $1`, id)
		s.Emit(ctx, Event{Kind: "stage", IssueID: id, From: from, To: to})
	}
}

// syncClosed: encerrada (resolvida ou cancelada) é o que a regra "Encerrar"
// da etapa diz; done_at marca quando foi resolvida (base do analytics).
func (s *Store) syncClosed(ctx context.Context, id, stage string) {
	var wsID string
	s.DB.QueryRow(ctx, `select workspace_id::text from issues where id = $1`, id).Scan(&wsID)
	closed := ""
	if pols, err := s.policies(ctx, wsID, stage); err == nil {
		closed = pols[stage].Close
	}
	s.DB.Exec(ctx, `update issues set closed = $2,
		done_at = case when $2 = 'done' then coalesce(done_at, now()) else null end where id = $1`, id, closed)
}

// SetRunOutcome guarda o que a IA declarou ao terminar.
func (s *Store) SetRunOutcome(ctx context.Context, runID, outcome, note string) error {
	_, err := s.DB.Exec(ctx, `update runs set outcome = $2, outcome_note = $3 where id = $1`, runID, outcome, note)
	return err
}

// PersonCounts: issues abertas com a pessoa de responsável, criadas por ela e resolvidas por ela.
func (s *Store) PersonCounts(ctx context.Context, wsID, userID string) (open, created, resolved int) {
	s.DB.QueryRow(ctx, `select
		count(*) filter (where assignee_id = $2 and closed = ''),
		count(*) filter (where created_by = $2),
		count(*) filter (where assignee_id = $2 and closed = 'done')
		from issues where workspace_id = $1`, wsID, userID).Scan(&open, &created, &resolved)
	return
}
