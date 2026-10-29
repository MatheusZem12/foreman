package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"

	"foreman/internal/store"
)

// Users and roles are global; workspace access isn't. Every reference to a person in
// the workflow (stage access, assignee, recipient, approver) has to be someone with
// access to the workspace: the server refuses on save, and the workflow screen warns
// when someone loses access later.

// ---------- etapas ----------

func (a *API) listStages(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.Stages(r.Context(), chi.URLParam(r, "ws"))
}

// The stage itself is just a name, a position and whether it runs in parallel with the
// previous one; who may, locks and approval are access rules. The color comes from the palette.
type stageInput struct {
	Name     string `json:"name"`
	After    string `json:"after"`    // etapa depois da qual a nova entra
	Parallel *bool  `json:"parallel"` // next to the previous stage
}

var stagePalette = []string{"#a78bfa", "#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#a3e635", "#fb923c", "#94a3b8"}

// nextColor: the first palette color no stage uses (or the least repeated one).
func nextColor(stages []store.Stage) string {
	best, min := stagePalette[0], 1<<30
	for _, c := range stagePalette {
		n := 0
		for _, s := range stages {
			if strings.EqualFold(s.Color, c) {
				n++
			}
		}
		if n < min {
			best, min = c, n
		}
	}
	return best
}

func positionAfter(stages []store.Stage, after string) float64 {
	for i, s := range stages {
		if s.ID != after {
			continue
		}
		if i+1 < len(stages) {
			return (s.Position + stages[i+1].Position) / 2
		}
		return s.Position + 10
	}
	return stages[len(stages)-1].Position + 10
}

// checkWho: roles exist and users have access to the workspace.
func (a *API) checkWho(ctx context.Context, wsID string, w store.Who, what string) error {
	roles, err := a.st.ListRoles(ctx)
	if err != nil {
		return err
	}
	for _, id := range w.Roles {
		if !slices.ContainsFunc(roles, func(r store.Role) bool { return r.ID == id }) {
			return bad("%s: role doesn't exist", what)
		}
	}
	ids, err := a.st.WorkspaceUserIDs(ctx, wsID)
	if err != nil {
		return err
	}
	for _, id := range w.Users {
		if !ids[id] {
			name := id
			if u, err := a.st.UserByID(ctx, id); err == nil {
				name = u.Name
			}
			return bad("%s: %s doesn't have access to this workspace", what, name)
		}
	}
	return nil
}

func (a *API) saveStage(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	wsID := chi.URLParam(r, "ws")
	var in stageInput
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, bad("give the stage a name")
	}
	all, err := a.st.Stages(ctx, wsID)
	if err != nil {
		return nil, err
	}
	st := store.Stage{WorkspaceID: wsID, Name: in.Name, Color: nextColor(all)}
	if id := chi.URLParam(r, "id"); id != "" {
		cur, err := a.st.StageOf(ctx, wsID, id)
		if err != nil {
			return nil, err
		}
		st.ID, st.Color, st.Position, st.Parallel = cur.ID, cur.Color, cur.Position, cur.Parallel
	}
	if in.Parallel != nil {
		st.Parallel = *in.Parallel
	}
	if st.ID == "" || in.After != "" {
		all = slices.DeleteFunc(all, func(x store.Stage) bool { return x.ID == st.ID })
		after := in.After
		if after == "" && len(all) > 0 {
			after = all[len(all)-1].ID
		}
		st.Position = positionAfter(all, after)
	}
	return a.st.SaveStage(ctx, st)
}

func (a *API) orderStages(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	wsID := chi.URLParam(r, "ws")
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	all, err := a.st.Stages(ctx, wsID)
	if err != nil {
		return nil, err
	}
	if len(in.IDs) != len(all) {
		return nil, bad("send the order of every stage")
	}
	for _, s := range all {
		if !slices.Contains(in.IDs, s.ID) {
			return nil, bad("stage missing from the order: %s", s.Name)
		}
	}
	if err := a.st.SetStageOrder(ctx, wsID, in.IDs); err != nil {
		return nil, err
	}
	return a.st.Stages(ctx, wsID)
}

func (a *API) deleteStage(w http.ResponseWriter, r *http.Request) (any, error) {
	st, err := a.st.StageOf(r.Context(), chi.URLParam(r, "ws"), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if all, _ := a.st.Stages(r.Context(), st.WorkspaceID); len(all) <= 1 {
		return nil, bad("the workflow needs at least one stage")
	}
	return nil, a.st.DeleteStage(r.Context(), st)
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---------- regras ----------

func (a *API) listRules(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListRules(r.Context(), chi.URLParam(r, "ws"))
}

// ruleConfig is the part of the config the server checks.
type ruleConfig struct {
	To      string   `json:"to"`
	Roles   []string `json:"roles"`
	Users   []string `json:"users"`
	URL     string   `json:"url"`
	Script  string   `json:"script"`
	OnFail  string   `json:"onFail"`
	OnWait  string   `json:"onWaiting"`
	AgentID string   `json:"agentId"`
	LabelID string   `json:"labelId"`
	Mode    string   `json:"mode"`
	Message string   `json:"message"`
	store.AccessConfig
}

var notifyTargets = map[string]bool{"requester": true, "creator": true, "assignee": true, "responsible": true, "team": true, "admins": true, "roles": true, "users": true}

func (a *API) checkRule(ctx context.Context, in *store.Rule) error {
	if !store.RuleTriggers[in.Trigger] {
		return bad("unknown trigger")
	}
	if in.Trigger == "access" {
		return a.checkAccess(ctx, in)
	}
	if !store.RuleActions[in.Action] {
		return bad("unknown action")
	}
	if store.TriggerNeedsStage(in.Trigger) {
		if !a.st.ValidStage(ctx, in.WorkspaceID, in.Stage) {
			return bad("choose the trigger's stage")
		}
	} else {
		in.Stage = ""
	}
	var cond store.Conditions
	if len(in.Conditions) > 0 && json.Unmarshal(in.Conditions, &cond) != nil {
		return bad("invalid conditions")
	}
	for _, st := range cond.Stages {
		if !a.st.ValidStage(ctx, in.WorkspaceID, st) {
			return bad("invalid stage in the filters")
		}
	}
	if in.Trigger == "stale" && cond.Hours <= 0 {
		return bad("enter after how many idle hours")
	}
	if in.Trigger == "cost_over" && cond.Cost <= 0 {
		return bad("enter the amount in US$")
	}
	var c ruleConfig
	if len(in.Config) > 0 && json.Unmarshal(in.Config, &c) != nil {
		return bad("invalid configuration")
	}
	who := store.Who{Roles: c.Roles, Users: c.Users}
	switch in.Action {
	case "notify":
		if !notifyTargets[c.To] {
			return bad("choose whom to notify")
		}
		if c.To == "roles" && len(c.Roles) == 0 || c.To == "users" && len(c.Users) == 0 {
			return bad("choose at least one role or user")
		}
		if err := a.checkWho(ctx, in.WorkspaceID, who, "Recipients"); err != nil {
			return err
		}
	case "assign":
		if (c.Mode == "" || c.Mode == "user") && len(c.Users) == 0 || c.Mode == "balance" && who.Empty() {
			return bad("choose who will be the assignee")
		}
		if err := a.checkWho(ctx, in.WorkspaceID, who, "Assignee"); err != nil {
			return err
		}
	case "move":
		if c.To == "" || (store.TriggerNeedsStage(in.Trigger) && c.To == in.Stage) || !a.st.ValidStage(ctx, in.WorkspaceID, c.To) {
			return bad("choose the target stage (different from the trigger's)")
		}
	case "webhook":
		if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
			return bad("enter the webhook URL (http/https)")
		}
	case "script":
		if strings.TrimSpace(c.Script) == "" {
			return bad("write the script")
		}
	case "set_agent":
		if _, err := a.st.Agent(ctx, c.AgentID); err != nil {
			return bad("choose the agent")
		}
	case "add_label":
		l, err := a.st.Label(ctx, c.LabelID)
		if err != nil || l.WorkspaceID != in.WorkspaceID {
			return bad("choose a label from this workspace")
		}
	case "comment":
		if strings.TrimSpace(c.Message) == "" {
			return bad("write the comment")
		}
	}
	if c.OnFail != "" && !a.st.ValidStage(ctx, in.WorkspaceID, c.OnFail) {
		return bad("invalid failure stage")
	}
	if c.OnWait != "" && !a.st.ValidStage(ctx, in.WorkspaceID, c.OnWait) {
		return bad("invalid stage")
	}
	return nil
}

var lockFields = []string{"title", "description", "priority", "labels", "agent", "repos", "assignee"}
var requirements = []string{"agent", "assignee", "description", "changes"}

// checkAccess: a stage's access rule (who may, locks, requirements, limit, approval,
// owners). It has no filters: it always applies.
func (a *API) checkAccess(ctx context.Context, in *store.Rule) error {
	if !store.AccessActions[in.Action] {
		return bad("unknown action")
	}
	if !a.st.ValidStage(ctx, in.WorkspaceID, in.Stage) {
		return bad("choose the stage")
	}
	in.Conditions = json.RawMessage("{}")
	var c store.AccessConfig
	if len(in.Config) > 0 && json.Unmarshal(in.Config, &c) != nil {
		return bad("invalid configuration")
	}
	who := store.Who{Roles: c.Roles, Users: c.Users}
	switch in.Action {
	case "allow_act", "allow_enter", "responsible":
		if who.Empty() {
			return bad("choose at least one role or person")
		}
	case "lock_fields":
		if len(c.Fields) == 0 || slices.ContainsFunc(c.Fields, func(f string) bool { return !slices.Contains(lockFields, f) }) {
			return bad("choose what gets locked")
		}
	case "require":
		if len(c.Requires) == 0 || slices.ContainsFunc(c.Requires, func(f string) bool { return !slices.Contains(requirements, f) }) {
			return bad("choose what the issue must have")
		}
	case "wip":
		if c.WIP < 1 {
			return bad("enter the issue limit")
		}
	case "close":
		if c.Kind != "done" && c.Kind != "cancelled" {
			return bad("choose whether the issue ends up done or cancelled")
		}
	case "approval":
		if c.Approvals < 1 || c.Approvals > 10 {
			return bad("from 1 to 10 approvals")
		}
		if c.To == "" || c.To == in.Stage || !a.st.ValidStage(ctx, in.WorkspaceID, c.To) {
			return bad("choose where the issue goes once approved")
		}
	}
	return a.checkWho(ctx, in.WorkspaceID, who, "People in the rule")
}

func (a *API) saveRule(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		store.Rule
		Enabled *bool `json:"enabled"` // ausente = ativa
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	in := body.Rule
	in.Enabled = body.Enabled == nil || *body.Enabled
	if in.Trigger == "" {
		in.Trigger = "enter"
	}
	ctx := r.Context()
	if id := chi.URLParam(r, "id"); id != "" {
		cur, err := a.st.Rule(ctx, id)
		if err != nil {
			return nil, err
		}
		if err := a.ensureAccess(r, cur.WorkspaceID); err != nil {
			return nil, err
		}
		in.ID, in.WorkspaceID = cur.ID, cur.WorkspaceID
	} else {
		in.WorkspaceID = chi.URLParam(r, "ws")
	}
	if err := a.checkRule(ctx, &in); err != nil {
		return nil, err
	}
	return a.st.SaveRule(ctx, in)
}

// orderRules saves the order the rules run in (a list of ids).
func (a *API) orderRules(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	wsID := chi.URLParam(r, "ws")
	if err := a.st.SetRuleOrder(r.Context(), wsID, in.IDs); err != nil {
		return nil, err
	}
	return a.st.ListRules(r.Context(), wsID)
}

func (a *API) deleteRule(w http.ResponseWriter, r *http.Request) (any, error) {
	cur, err := a.st.Rule(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, cur.WorkspaceID); err != nil {
		return nil, err
	}
	return nil, a.st.DeleteRule(r.Context(), cur.ID)
}

// ---------- alertas ----------

var actionNames = map[string]string{
	"allow_act": "who works on it", "allow_enter": "who brings issues", "read_only": "read-only", "lock_fields": "locked fields",
	"require": "requirements", "wip": "issue limit", "approval": "approval", "responsible": "owners",
	"notify": "notify", "webhook": "webhook", "move": "move", "run_agent": "run agent", "open_pr": "open PR", "merge": "merge",
	"script": "script", "set_agent": "set agent", "set_priority": "set priority", "add_label": "add label",
	"assign": "set assignee", "comment": "comment", "stop_agent": "stop the agent", "close": "close the issue",
}

type warning struct {
	Where   string `json:"where"`
	Message string `json:"message"`
	StageID string `json:"stageId,omitempty"`
	RuleID  string `json:"ruleId,omitempty"`
}

// workflowWarnings: references to people without access, roles or labels that
// disappeared, archived agents. Used on the workflow screen and in duplication.
func (a *API) workflowWarnings(ctx context.Context, wsID string, stages []store.Stage, rules []store.Rule) []warning {
	out := []warning{}
	access, _ := a.st.WorkspaceUserIDs(ctx, wsID)
	roles, _ := a.st.ListRoles(ctx)
	users, _ := a.st.ListUsers(ctx)
	name := func(id string) string {
		for _, u := range users {
			if u.ID == id {
				return u.Name
			}
		}
		return tr(ctx, "removed user")
	}
	checkWho := func(w store.Who, where, stageID, ruleID string) {
		for _, id := range w.Users {
			if !access[id] {
				out = append(out, warning{where, tr(ctx, "%s doesn't have access to this workspace", name(id)), stageID, ruleID})
			}
		}
		for _, id := range w.Roles {
			if !slices.ContainsFunc(roles, func(r store.Role) bool { return r.ID == id }) {
				out = append(out, warning{where, tr(ctx, "a role used here was deleted"), stageID, ruleID})
			}
		}
	}
	stageName := func(id string) string {
		for _, s := range stages {
			if s.ID == id {
				return s.Name
			}
		}
		return id
	}
	for _, r := range rules {
		var c ruleConfig
		json.Unmarshal(r.Config, &c)
		where := tr(ctx, "Rule %s", tr(ctx, firstNonEmptyStr(actionNames[r.Action], r.Action)))
		if r.Stage != "" {
			where = tr(ctx, "Stage %s · %s", stageName(r.Stage), tr(ctx, firstNonEmptyStr(actionNames[r.Action], r.Action)))
		}
		checkWho(store.Who{Roles: c.Roles, Users: c.Users}, where, "", r.ID)
		if c.LabelID != "" {
			if l, err := a.st.Label(ctx, c.LabelID); err != nil || l.WorkspaceID != wsID {
				out = append(out, warning{where, tr(ctx, "this rule's label doesn't exist in this workspace"), "", r.ID})
			}
		}
		if c.AgentID != "" {
			if ag, err := a.st.Agent(ctx, c.AgentID); err != nil || ag.Archived {
				out = append(out, warning{where, tr(ctx, "this rule's agent was archived"), "", r.ID})
			}
		}
	}
	return out
}

func (a *API) getWarnings(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	wsID := chi.URLParam(r, "ws")
	stages, err := a.st.Stages(ctx, wsID)
	if err != nil {
		return nil, err
	}
	rules, err := a.st.ListRules(ctx, wsID)
	if err != nil {
		return nil, err
	}
	return a.workflowWarnings(ctx, wsID, stages, rules), nil
}

// ---------- duplicar o fluxo ----------

// copyWorkflow replaces the destination's workflow with the origin's, as is: stages,
// rules and access rules. The destination's workflow is undone; issues in stages that
// stop existing go to the first stage. People without access to the destination are
// copied as they are and show up in the destination's warnings for someone to fix
// (they gain no access nor receive anything because of it). Only labels change: they
// belong to the workspace, so they are matched or created by name.
// dryRun returns what will happen, to confirm first.
func (a *API) copyWorkflow(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	from := chi.URLParam(r, "ws")
	var in struct {
		To     string `json:"to"`
		DryRun bool   `json:"dryRun"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if in.To == "" || in.To == from {
		return nil, bad("choose another destination workspace")
	}
	if err := a.ensureAccess(r, in.To); err != nil {
		return nil, err
	}
	stages, err := a.st.Stages(ctx, from)
	if err != nil {
		return nil, err
	}
	rules, err := a.st.ListRules(ctx, from)
	if err != nil {
		return nil, err
	}
	oldStages, _ := a.st.Stages(ctx, in.To)
	oldRules, _ := a.st.ListRules(ctx, in.To)
	keep := map[string]bool{}
	for _, st := range stages {
		keep[st.ID] = true
	}
	moved := 0
	for _, st := range oldStages {
		if !keep[st.ID] {
			moved += a.st.CountInStage(ctx, in.To, st.ID)
		}
	}

	notes := []warning{}
	destLabels, _ := a.st.ListLabels(ctx, in.To)
	for i := range rules {
		rl := &rules[i]
		var c map[string]any
		json.Unmarshal(rl.Config, &c)
		lid, _ := c["labelId"].(string)
		if lid == "" {
			continue
		}
		l, err := a.st.Label(ctx, lid)
		if err != nil {
			continue
		}
		idx := slices.IndexFunc(destLabels, func(x store.Label) bool { return strings.EqualFold(x.Name, l.Name) })
		switch {
		case idx >= 0:
			c["labelId"] = destLabels[idx].ID
		case in.DryRun:
			notes = append(notes, warning{Where: tr(ctx, "Rule %s", tr(ctx, firstNonEmptyStr(actionNames[rl.Action], rl.Action))), Message: tr(ctx, "the label %s will be created in the destination", l.Name)})
		default:
			if nl, err := a.st.CreateLabel(ctx, in.To, l.Name, l.Color); err == nil {
				c["labelId"] = nl.ID
				destLabels = append(destLabels, *nl)
			}
		}
		rl.Config, _ = json.Marshal(c)
	}
	// What will need fixing in the destination (people without access, deleted roles…).
	warns := append(a.workflowWarnings(ctx, in.To, stages, rules), notes...)
	out := map[string]any{"warnings": warns, "stages": len(stages), "rules": len(rules),
		"replaced": map[string]int{"stages": len(oldStages), "rules": len(oldRules)}, "movedIssues": moved}
	if in.DryRun {
		return out, nil
	}
	if err := a.st.ReplaceWorkflow(ctx, in.To, stages, rules); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- aprovar ----------

// approveIssue records the person's approval in the current stage. When it reaches the
// number the stage asks for, the issue moves on to the approval's destination.
func (a *API) approveIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	is, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	u := userOf(r)
	st, p := a.policyOf(ctx, is.WorkspaceID, is.Status)
	if st == nil || p.Approvals <= 0 {
		return nil, bad("this stage has no approval")
	}
	if p.ReadOnly && !u.IsOwner {
		return nil, forbidden("%s is read-only", st.Name)
	}
	if !u.IsOwner {
		if err := need(u, "issue.approve", "approve issues"); err != nil {
			return nil, err
		}
		if !p.Approvers.Empty() && !p.Approvers.Includes(u) {
			return nil, forbidden("in %s, only %s approves", st.Name, a.whoText(ctx, p.Approvers))
		}
	}
	if is.ActiveRun != nil {
		return nil, bad("wait for the run to finish before approving")
	}
	n, err := a.st.Approve(ctx, is.ID, is.Status, u.ID)
	if err != nil {
		return nil, err
	}
	if n >= p.Approvals {
		to := p.ApproveTo
		if err := a.st.SetIssueStatus(store.WithActor(ctx, u.ID), is.ID, to); err != nil {
			return nil, err
		}
	} else {
		a.run.SystemComment(ctx, is, fmt.Sprintf("✓ %s approved (%d of %d).", u.Name, n, p.Approvals))
	}
	is, _ = a.st.Issue(ctx, is.ID)
	a.publishIssue(is)
	return map[string]any{"issue": is, "approvals": n, "needed": p.Approvals}, nil
}

// ---------- skills ↔ agentes ----------

// skillAgents: vincula a skill exatamente aos agentes informados.
func (a *API) skillAgents(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		AgentIDs []string `json:"agentIds"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if err := a.st.SetSkillAgents(r.Context(), chi.URLParam(r, "id"), in.AgentIDs); err != nil {
		return nil, err
	}
	return a.st.ListAgents(r.Context())
}

// ---------- a person's profile ----------

type profileWorkspace struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Key      string   `json:"key"`
	Roles    []string `json:"roles"`    // what they do in each stage (e.g. "Triage: works on issues, approves")
	Rules    int      `json:"rules"`    // rules that mention the person (recipient, assignee)
	Open     int      `json:"open"`     // open issues with them as assignee
	Created  int      `json:"created"`  // issues they created
	Resolved int      `json:"resolved"` // with them as assignee, done
}

// userProfile: who the person is and what they do in each workspace that whoever asks
// also sees.
func (a *API) userProfile(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	target, err := a.st.UserByID(ctx, chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	viewerWs, err := a.st.ListWorkspacesFor(ctx, userOf(r))
	if err != nil {
		return nil, err
	}
	targetIDs, err := a.st.WorkspaceIDsFor(ctx, target)
	if err != nil {
		return nil, err
	}
	out := []profileWorkspace{}
	for _, ws := range viewerWs {
		if targetIDs != nil && !slices.Contains(targetIDs, ws.ID) {
			continue
		}
		p := profileWorkspace{ID: ws.ID, Name: ws.Name, Key: ws.Key, Roles: []string{}}
		if stages, err := a.st.Stages(ctx, ws.ID); err == nil {
			for _, st := range stages {
				var parts []string
				pol := st.Policy
				if pol.Act.Has(target) {
					parts = append(parts, tr(ctx, "works on issues"))
				}
				if pol.Enter.Has(target) {
					parts = append(parts, tr(ctx, "brings issues"))
				}
				if pol.Approvals > 0 && pol.Approvers.Has(target) {
					parts = append(parts, tr(ctx, "approves"))
				}
				if pol.Responsible.Has(target) {
					parts = append(parts, tr(ctx, "is an owner"))
				}
				if len(parts) > 0 {
					p.Roles = append(p.Roles, st.Name+": "+strings.Join(parts, ", "))
				}
			}
		}
		if rules, err := a.st.ListRules(ctx, ws.ID); err == nil {
			for _, rl := range rules {
				var c ruleConfig
				json.Unmarshal(rl.Config, &c)
				if (store.Who{Roles: c.Roles, Users: c.Users}).Has(target) {
					p.Rules++
				}
			}
		}
		p.Open, p.Created, p.Resolved = a.st.PersonCounts(ctx, ws.ID, target.ID)
		out = append(out, p)
	}
	return map[string]any{"user": target, "workspaces": out, "allWorkspaces": targetIDs == nil}, nil
}
