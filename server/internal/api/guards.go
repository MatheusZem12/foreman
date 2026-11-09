package api

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"foreman/internal/store"
)

// Two layers decide what someone can do on an issue:
//  1. the role's permission (global): issue.priority, issue.agent…
//  2. the policy of the stage the issue is in (per workspace): who works on the issues
//     there, who can bring issues there, locked fields, requirements, issue limit
//     and approvals.
// The owner passes everything. E.g. an intern and a junior with the same permission
// role, but the "Triage" stage only accepts the Intern role and "Development" only
// the Junior one: each works on their own.

func forbidden(format string, a ...any) error {
	return httpError{http.StatusForbidden, fmt.Sprintf(format, a...), format, a}
}

// Issue field → the permission needed and the field's name for the stage locks.
var fieldRules = map[string]struct{ perm, lock, label string }{
	"title":       {"issue.edit", "title", "the title"},
	"description": {"issue.edit", "description", "the description"},
	"summary":     {"issue.edit", "description", "the README"},
	"priority":    {"issue.priority", "priority", "the priority"},
	"labelIds":    {"issue.labels", "labels", "the labels"},
	"agentId":     {"issue.agent", "agent", "the agent"},
	"skillIds":    {"issue.agent", "agent", "the skills"},
	"assigneeId":  {"issue.assign", "assignee", "the assignee"},
	"repos":       {"issue.repos", "repos", "the repositories"},
	"status":      {"issue.move", "", "the stage"},
	"position":    {"issue.move", "", "the order"},
}

func (a *API) policyOf(ctx context.Context, wsID, stage string) (*store.Stage, store.StagePolicy) {
	st, err := a.st.StageOf(ctx, wsID, stage)
	if err != nil {
		return nil, store.StagePolicy{}
	}
	return st, st.Policy
}

// whoText describes a group for the error messages.
func (a *API) whoText(ctx context.Context, w store.Who) string {
	var parts []string
	if roles, err := a.st.ListRoles(ctx); err == nil {
		for _, r := range roles {
			if slices.Contains(w.Roles, r.ID) {
				parts = append(parts, tr(ctx, "role %s", r.Name))
			}
		}
	}
	for _, id := range w.Users {
		if u, err := a.st.UserByID(ctx, id); err == nil {
			parts = append(parts, u.Name)
		}
	}
	if len(parts) == 0 {
		return tr(ctx, "other people")
	}
	return strings.Join(parts, ", ")
}

// canAct: the person can work on the issues of the current stage.
func (a *API) canAct(ctx context.Context, u *store.User, is *store.Issue) error {
	st, p := a.policyOf(ctx, is.WorkspaceID, is.Status)
	if st != nil && p.ReadOnly && !u.IsOwner {
		return forbidden("%s is read-only: the issue doesn't change here anymore", st.Name)
	}
	if st != nil && !p.Act.Includes(u) {
		return forbidden("in the %s stage, only %s works on issues", st.Name, a.whoText(ctx, p.Act))
	}
	return nil
}

// need: the role's permission.
func need(u *store.User, perm, what string) error {
	if !u.Can(perm) {
		return forbidden("your role can't %s", what)
	}
	return nil
}

// canField: the role's permission + the field not locked in the stage.
func (a *API) canField(ctx context.Context, u *store.User, is *store.Issue, field string) error {
	fr, ok := fieldRules[field]
	if !ok {
		return nil
	}
	if !u.Can(fr.perm) {
		return forbidden("your role can't change %s", fr.label)
	}
	if fr.lock != "" && !u.IsOwner {
		if st, p := a.policyOf(ctx, is.WorkspaceID, is.Status); st != nil && slices.Contains(p.Locked, fr.lock) {
			return forbidden("in the %s stage, %s is locked", st.Name, fr.label)
		}
	}
	return nil
}

// canEnter: the issue (already with the new fields) can enter the "to" stage.
func (a *API) canEnter(ctx context.Context, u *store.User, is *store.Issue, to string) error {
	st, p := a.policyOf(ctx, is.WorkspaceID, to)
	if st == nil {
		return bad("invalid stage")
	}
	if !p.Enter.Includes(u) {
		return forbidden("only %s can bring issues to %s", a.whoText(ctx, p.Enter), st.Name)
	}
	return a.enterLimits(ctx, st, is)
}

// approvalGate: an approval means nothing if it can be walked around. to = the stage it is
// going to, or "" for the merge button. Without enough approvals (the owner goes through):
//   - it doesn't leave an approval stage for that stage's destination;
//   - code still waiting to be merged doesn't reach that destination by another route;
//   - that code isn't merged by hand.
//
// An issue without pending code has nothing to protect, so manual tasks stay free.
func (a *API) approvalGate(ctx context.Context, u *store.User, is *store.Issue, to string) error {
	if u.IsOwner {
		return nil
	}
	pending := slices.ContainsFunc(is.Repos, func(r store.IssueRepo) bool { return r.Changed && r.MergedInto == "" })
	stages, err := a.st.Stages(ctx, is.WorkspaceID)
	if err != nil {
		return err
	}
	for _, s := range stages {
		p := s.Policy
		if p.Approvals <= 0 || (to != "" && p.ApproveTo != to) || (!pending && !(to != "" && s.ID == is.Status)) {
			continue
		}
		if n := a.st.ApprovalCount(ctx, is.ID, s.ID); n < p.Approvals {
			return forbidden("%s requires %d approval(s) first (it has %d)", s.Name, p.Approvals, n)
		}
	}
	return nil
}

// checkAgent: an agent that exists and wasn't archived.
func (a *API) checkAgent(ctx context.Context, id string) error {
	ag, err := a.st.Agent(ctx, id)
	if err != nil {
		return bad("agent not found")
	}
	if ag.Archived {
		return bad("the agent %s was archived: choose another one", ag.Name)
	}
	return nil
}

func (a *API) checkLabels(ctx context.Context, wsID string, ids []string) error {
	labels, err := a.st.ListLabels(ctx, wsID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !slices.ContainsFunc(labels, func(l store.Label) bool { return l.ID == id }) {
			return bad("label doesn't exist in this workspace")
		}
	}
	return nil
}

func (a *API) checkSkills(ctx context.Context, ids []string) error {
	skills, err := a.st.ListSkills(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !slices.ContainsFunc(skills, func(s store.Skill) bool { return s.ID == id }) {
			return bad("skill not found")
		}
	}
	return nil
}

// stringList reads a JSON list of strings.
func stringList(v any, what string) ([]string, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, bad("%s must be a list", what)
	}
	out := make([]string, 0, len(list))
	for _, x := range list {
		s, ok := x.(string)
		if !ok {
			return nil, bad("%s must be a list", what)
		}
		out = append(out, s)
	}
	return out, nil
}

// checkPatch: each field of an issue edit has the right type and points to something real,
// so bad input gets a clear answer instead of a database error.
func (a *API) checkPatch(ctx context.Context, is *store.Issue, patch map[string]any) error {
	for k, v := range patch {
		switch k {
		case "title":
			if t, ok := v.(string); !ok || strings.TrimSpace(t) == "" {
				return bad("the title can't be empty")
			}
		case "description", "summary":
			if _, ok := v.(string); !ok {
				return bad("%s must be text", k)
			}
		case "status":
			if s, ok := v.(string); !ok || !a.st.ValidStage(ctx, is.WorkspaceID, s) {
				return bad("invalid stage")
			}
		case "priority":
			if p, ok := v.(float64); !ok || p != float64(int(p)) || p < 0 || p > 4 {
				return bad("invalid priority")
			}
		case "position":
			if _, ok := v.(float64); !ok {
				return bad("invalid position")
			}
		case "agentId":
			if v == nil {
				continue
			}
			id, ok := v.(string)
			if !ok {
				return bad("agent not found")
			}
			if id != "" {
				if err := a.checkAgent(ctx, id); err != nil {
					return err
				}
			}
		case "assigneeId":
			if _, ok := v.(string); !ok && v != nil {
				return bad("that person doesn't have access to this workspace")
			}
		case "labelIds":
			ids, err := stringList(v, "labels")
			if err != nil {
				return err
			}
			if err := a.checkLabels(ctx, is.WorkspaceID, ids); err != nil {
				return err
			}
		case "skillIds":
			ids, err := stringList(v, "skills")
			if err != nil {
				return err
			}
			if err := a.checkSkills(ctx, ids); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkNewIssue: the same, for a new issue.
func (a *API) checkNewIssue(ctx context.Context, wsID string, in *store.NewIssue) error {
	if in.Priority < 0 || in.Priority > 4 {
		return bad("invalid priority")
	}
	if in.AgentID != nil {
		if err := a.checkAgent(ctx, *in.AgentID); err != nil {
			return err
		}
	}
	if err := a.checkLabels(ctx, wsID, in.LabelIDs); err != nil {
		return err
	}
	return a.checkSkills(ctx, in.SkillIDs)
}

// enterLimits: what a stage demands of any issue entering it, whoever brings it.
func (a *API) enterLimits(ctx context.Context, st *store.Stage, is *store.Issue) error {
	if p := st.Policy; p.WIP > 0 && is.Status != st.ID && a.st.CountInStage(ctx, is.WorkspaceID, st.ID) >= p.WIP {
		return bad("%s already has the maximum of %d issues; finish one first", st.Name, p.WIP)
	}
	return a.requirements(st, is)
}

func (a *API) requirements(st *store.Stage, is *store.Issue) error {
	for _, req := range st.Policy.Requires {
		switch req {
		case "agent":
			if is.AgentID == nil {
				return bad("to enter %s the issue needs an agent", st.Name)
			}
		case "assignee":
			if is.AssigneeID == nil {
				return bad("to enter %s the issue needs an assignee", st.Name)
			}
		case "description":
			if strings.TrimSpace(is.Description) == "" {
				return bad("to enter %s the issue needs a description", st.Name)
			}
		case "changes":
			if !slices.ContainsFunc(is.Repos, func(r store.IssueRepo) bool { return r.Changed }) {
				return bad("to enter %s the issue needs code changes", st.Name)
			}
		}
	}
	return nil
}

// checkAssignee: the assignee needs access to the workspace.
func (a *API) checkAssignee(ctx context.Context, wsID string, id any) error {
	s, _ := id.(string)
	if s == "" {
		return nil
	}
	ids, err := a.st.WorkspaceUserIDs(ctx, wsID)
	if err != nil {
		return err
	}
	if !ids[s] {
		return bad("that person doesn't have access to this workspace")
	}
	return nil
}

// capsOf: what the person can do on this issue right now (the screen uses it to hide
// or lock controls; the server checks again on every action).
func (a *API) capsOf(ctx context.Context, u *store.User, is *store.Issue) map[string]any {
	actErr := a.canAct(ctx, u, is)
	act := actErr == nil
	f := func(field string) bool { return act && a.canField(ctx, u, is, field) == nil }
	_, p := a.policyOf(ctx, is.WorkspaceID, is.Status)
	approver := u.Can("issue.approve") && (p.Approvers.Empty() || p.Approvers.Includes(u))
	if u.IsOwner {
		approver = true
	} else if p.ReadOnly {
		approver = false
	}
	caps := map[string]any{
		"edit": f("title"), "move": f("status"), "priority": f("priority"), "labels": f("labelIds"),
		"agent": f("agentId"), "assign": f("assigneeId"),
		"repos":   act && u.Can("issue.repos") && (u.IsOwner || !slices.Contains(p.Locked, "repos")),
		"comment": act && u.Can("issue.comment"), "run": act && u.Can("issue.run"),
		// Already approved, but the stage has what it needs (it came back here): the button
		// just moves it on again, otherwise the issue would be stuck for one-person teams.
		"approve": p.Approvals > 0 && approver && (!slices.Contains(is.Approvals, u.ID) || len(is.Approvals) >= p.Approvals),
		"merge":   act && u.Can("issue.merge") && a.approvalGate(ctx, u, is, "") == nil, "delete": act && u.Can("issue.delete"),
		"approvals": p.Approvals, "approveTo": p.ApproveTo,
	}
	if actErr != nil {
		caps["reason"] = actErr.Error()
	}
	return caps
}

// guardNewIssue: whoever creates only sets what the role allows, and the initial stage
// must accept the person (and the requirements). E.g. an intern creates the issue, but
// without choosing an agent or a priority.
func (a *API) guardNewIssue(ctx context.Context, u *store.User, wsID string, in *store.NewIssue) error {
	if in.AgentID != nil {
		if err := need(u, "issue.agent", "choose the issue's agent"); err != nil {
			return err
		}
	}
	if len(in.SkillIDs) > 0 {
		if err := need(u, "issue.agent", "choose the issue's agent"); err != nil {
			return err
		}
	}
	if in.Priority != 0 {
		if err := need(u, "issue.priority", "set the priority"); err != nil {
			return err
		}
	}
	if len(in.LabelIDs) > 0 {
		if err := need(u, "issue.labels", "set labels"); err != nil {
			return err
		}
	}
	if len(in.RepoIDs) > 0 {
		if err := need(u, "issue.repos", "choose repositories"); err != nil {
			return err
		}
	}
	if in.AssigneeID != nil && *in.AssigneeID != "" {
		if err := need(u, "issue.assign", "set the assignee"); err != nil {
			return err
		}
		if err := a.checkAssignee(ctx, wsID, *in.AssigneeID); err != nil {
			return err
		}
	} else {
		in.AssigneeID = nil
	}
	draft := &store.Issue{WorkspaceID: wsID, Status: "", AgentID: in.AgentID, AssigneeID: in.AssigneeID, Description: in.Description}
	return a.canEnter(ctx, u, draft, in.Status)
}
