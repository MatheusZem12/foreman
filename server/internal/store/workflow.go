package store

import (
	"context"
	"encoding/json"
	"log"
	"slices"
	"time"
)

// ---------- etapas ----------

// Stage is a board column. Every workspace has the system ones (with their own
// behaviour: To do starts the agent, Done finishes…) and its own; all of them can be
// reordered and renamed. Who may, locks and approval are the stage's access rules
// (trigger "access"); Policy is their summary, built on read.
type Stage struct {
	ID          string      `db:"id" json:"id"`
	WorkspaceID string      `db:"workspace_id" json:"workspaceId,omitempty"`
	Name        string      `db:"name" json:"name"`
	Color       string      `db:"color" json:"color"`
	Position    float64     `db:"position" json:"position"`
	CreatedAt   time.Time   `db:"created_at" json:"-"`
	Policy      StagePolicy `db:"-" json:"policy"`          // derived from the access rules
	Parallel    bool        `db:"parallel" json:"parallel"` // next to the previous stage (same board column)
}

// Who is a group of people: roles and/or users. Empty = no restriction.
type Who struct {
	Roles []string `json:"roles,omitempty"`
	Users []string `json:"users,omitempty"`
}

func (w Who) Empty() bool { return len(w.Roles) == 0 && len(w.Users) == 0 }

// Has: the person is listed in the group (by user or role), without shortcuts.
func (w Who) Has(u *User) bool {
	return u != nil && (slices.Contains(w.Users, u.ID) || (u.RoleID != nil && slices.Contains(w.Roles, *u.RoleID)))
}

// Includes: the owner is always included; an empty group includes everybody.
func (w Who) Includes(u *User) bool {
	if u == nil {
		return false
	}
	if u.IsOwner || w.Empty() {
		return true
	}
	return slices.Contains(w.Users, u.ID) || (u.RoleID != nil && slices.Contains(w.Roles, *u.RoleID))
}

// StagePolicy is what applies to the issues in a stage: the sum of its active access
// rules.
type StagePolicy struct {
	Enter       Who      `json:"enter"`               // who can bring issues here
	Act         Who      `json:"act"`                 // who can work on the issues here (edit, comment, run, take out)
	Locked      []string `json:"locked,omitempty"`    // fields nobody changes here: title, description, priority, labels, agent, repos, assignee
	Requires    []string `json:"requires,omitempty"`  // to enter: agent, assignee, description, changes
	WIP         int      `json:"wip,omitempty"`       // maximum issues at the same time (0 = no limit)
	Approvals   int      `json:"approvals,omitempty"` // approvals needed (0 = a stage without approval)
	ApproveTo   string   `json:"approveTo,omitempty"` // where it goes once approved
	Approvers   Who      `json:"approvers"`           // who can approve (empty = whoever has issue.approve)
	Responsible Who      `json:"responsible"`         // the stage's owners (notifications, "mine")
	ReadOnly    bool     `json:"readOnly,omitempty"`  // once in here, nobody changes it (only the owner)
	Close       string   `json:"close,omitempty"`     // encerra a issue: done (resolvida) ou cancelled
}

// logStage fecha a passagem atual da issue e abre a da etapa nova.
func (s *Store) logStage(ctx context.Context, issueID, stage string) {
	s.DB.Exec(ctx, `update issue_stage_log set left_at = now() where issue_id = $1 and left_at is null`, issueID)
	s.DB.Exec(ctx, `insert into issue_stage_log(issue_id, workspace_id, stage) select id, workspace_id, $2 from issues where id = $1`, issueID, stage)
}

// EnabledNotifyRules: active e-mail rules (all of them), to warn when sending is turned off.
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

// AccessActions: what an access rule can say about the stage.
var AccessActions = map[string]bool{
	"allow_act": true, "allow_enter": true, "read_only": true, "lock_fields": true,
	"require": true, "wip": true, "approval": true, "responsible": true, "close": true,
}

// AccessConfig: the config of the access rules.
type AccessConfig struct {
	Roles     []string `json:"roles,omitempty"`
	Users     []string `json:"users,omitempty"`
	Fields    []string `json:"fields,omitempty"`    // lock_fields
	Requires  []string `json:"requires,omitempty"`  // require
	WIP       int      `json:"wip,omitempty"`       // wip
	Approvals int      `json:"approvals,omitempty"` // approval: quantas pessoas diferentes
	To        string   `json:"to,omitempty"`        // approval: where it goes
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

// policies adds up the active access rules per stage (empty stage = all). Several rules
// of the same type add up: lists are joined, the smallest limit applies and the most
// demanding approval applies.
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

// SetStageOrder saves the stage order (the full list of ids).
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

// FirstStage: the workflow's first stage (where whatever has no stage goes).
func (s *Store) FirstStage(ctx context.Context, wsID string) string {
	var id string
	s.DB.QueryRow(ctx, `select id from stages where workspace_id = $1 order by position, created_at limit 1`, wsID).Scan(&id)
	return id
}

// DeleteStage sends the stage's issues to the first of the remaining ones and deletes its rules.
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

// OpenLoad: open issues per assignee (to distribute work).
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

// CountInStage: issues in a stage (for the WIP limit).
func (s *Store) CountInStage(ctx context.Context, wsID, stage string) int {
	var n int
	s.DB.QueryRow(ctx, `select count(*) from issues where workspace_id = $1 and status = $2`, wsID, stage).Scan(&n)
	return n
}

// ---------- regras ----------

// Rule: when the trigger happens (and the conditions match), it performs the action.
type Rule struct {
	ID          string          `db:"id" json:"id"`
	WorkspaceID string          `db:"workspace_id" json:"workspaceId"`
	Stage       string          `db:"stage" json:"stage"` // the trigger's stage (enter/leave/stale); empty for the others
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
	"created": true, "commented": true, "run_started": true, "run_finished": true, "merged": true, "merge_conflict": true, "rule_failed": true,
	"cost_over": true, "assigned": true, "priority_changed": true,
}

func TriggerNeedsStage(t string) bool {
	return t == "enter" || t == "leave" || t == "stale" || t == "access"
}

var RuleActions = map[string]bool{
	"notify": true, "webhook": true, "move": true, "run_agent": true, "open_pr": true, "merge": true, "script": true,
	"set_agent": true, "set_priority": true, "add_label": true, "assign": true, "comment": true, "stop_agent": true,
}

// Conditions: filters the issue has to meet for the rule to fire.
type Conditions struct {
	Priorities []int    `json:"priorities,omitempty"` // 1 urgent … 4 low, 0 none
	Labels     []string `json:"labels,omitempty"`     // tem alguma destas
	Agents     []string `json:"agents,omitempty"`     // the issue's agent is one of these
	Outcomes   []string `json:"outcomes,omitempty"`   // run_finished: done, waiting, incomplete, failed, cancelled
	Stages     []string `json:"stages,omitempty"`     // the issue is in one of these stages (triggers without a stage)
	Hours      float64  `json:"hours,omitempty"`      // stale: horas paradas na etapa
	Cost       float64  `json:"cost,omitempty"`       // cost_over: US$
	ActorRoles []string `json:"actorRoles,omitempty"` // whoever caused the event has one of these roles
}

func (s *Store) ListRules(ctx context.Context, wsID string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where workspace_id = $1 order by trigger, stage, position, created_at`, wsID)
}

// RulesFor: a trigger's active rules (and stage, when the trigger has one).
func (s *Store) RulesFor(ctx context.Context, wsID, trigger, stage string) ([]Rule, error) {
	return many[Rule](ctx, s, `select * from rules where workspace_id = $1 and trigger = $2 and stage = $3 and enabled
		order by position, created_at`, wsID, trigger, stage)
}

// RulesByTrigger: a trigger's active rules across all workspaces (the time sweep).
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

// SetRuleOrder saves the order the rules run in (ids of the same workspace).
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

// MarkFired records a rule's single firing on an issue; false if it already fired.
func (s *Store) MarkFired(ctx context.Context, ruleID, issueID string) bool {
	tag, err := s.DB.Exec(ctx, `insert into rule_fires(rule_id, issue_id) values($1, $2) on conflict do nothing`, ruleID, issueID)
	return err == nil && tag.RowsAffected() > 0
}

// StaleIssues: issues sitting in the stage for more than `hours` hours.
func (s *Store) StaleIssues(ctx context.Context, wsID, stage string, hours float64) ([]Issue, error) {
	return many[Issue](ctx, s, issueSelect+` where i.workspace_id = $1 and i.status = $2
		and i.stage_entered_at < now() - make_interval(secs => $3)`, wsID, stage, hours*3600)
}

// CostlyIssues: issues abertas cujo custo somado passou de usd.
func (s *Store) CostlyIssues(ctx context.Context, wsID string, usd float64) ([]Issue, error) {
	return many[Issue](ctx, s, issueSelect+` where i.workspace_id = $1 and i.closed = ''
		and (select coalesce(sum(cost_usd), 0) from runs where issue_id = i.id) > $2`, wsID, usd)
}

// seedWorkflow: the default workflow (stages and rules) every workspace is born with.
// It lives in the database (the seed_workflow function, migration 016) and is fully editable.
func (s *Store) seedWorkflow(ctx context.Context, wsID string) {
	if _, err := s.DB.Exec(ctx, `select seed_workflow($1)`, wsID); err != nil {
		log.Printf("default workflow of %s: %v", wsID, err)
	}
}

// ReplaceWorkflow replaces the workspace's stages and rules with the given ones (duplication).
// Issues in stages that stop existing go to the first stage.
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

// ---------- approvals ----------

// Approve records the person's approval in the current stage; returns the total.
func (s *Store) Approve(ctx context.Context, issueID, stage, userID string) (int, error) {
	if _, err := s.DB.Exec(ctx, `insert into issue_approvals(issue_id, stage, user_id) values($1,$2,$3) on conflict do nothing`, issueID, stage, userID); err != nil {
		return 0, err
	}
	var n int
	err := s.DB.QueryRow(ctx, `select count(*) from issue_approvals where issue_id = $1 and stage = $2`, issueID, stage).Scan(&n)
	return n, err
}

// ---------- entrada por webhook ----------

// ---------- members with access ----------

// WorkspaceUserIDs: who has access to the workspace (link or "see all").
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

// ---------- stage changes and events ----------

// Event is reported to the automation engine: stage change, issue created, comment,
// run finished, assignee or priority changed.
type Event struct {
	Kind    string // stage | created | commented | run_started | run_finished | merged | merge_conflict | assigned | priority_changed
	IssueID string
	From    string // stage: etapa de onde saiu
	To      string // stage: the stage it went to
	ActorID *string
	Outcome string // run_finished: done | waiting | incomplete | failed | cancelled
}

// StatusChange is the stage change event (kept for the runner/engine).
type StatusChange = Event

type actorKey struct{}

// WithActor marks in the context who is making the change.
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
		// "sitting for X hours" applies again on every new stage.
		s.DB.Exec(ctx, `delete from rule_fires f using rules r where f.rule_id = r.id and r.trigger = 'stale' and f.issue_id = $1`, id)
		s.Emit(ctx, Event{Kind: "stage", IssueID: id, From: from, To: to})
	}
}

// syncClosed: closed (resolved or cancelled) is what the stage's "Close" rule says;
// done_at marks when it was resolved (the basis of analytics).
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

// SetRunOutcome stores what the AI declared when it finished.
func (s *Store) SetRunOutcome(ctx context.Context, runID, outcome, note string) error {
	_, err := s.DB.Exec(ctx, `update runs set outcome = $2, outcome_note = $3 where id = $1`, runID, outcome, note)
	return err
}

// PersonCounts: open issues with the person as assignee, created by them and resolved by them.
func (s *Store) PersonCounts(ctx context.Context, wsID, userID string) (open, created, resolved int) {
	s.DB.QueryRow(ctx, `select
		count(*) filter (where assignee_id = $2 and closed = ''),
		count(*) filter (where created_by = $2),
		count(*) filter (where assignee_id = $2 and closed = 'done')
		from issues where workspace_id = $1`, wsID, userID).Scan(&open, &created, &resolved)
	return
}
