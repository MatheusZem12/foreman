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
	if p.WIP > 0 && is.Status != to && a.st.CountInStage(ctx, is.WorkspaceID, to) >= p.WIP {
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
		"approve": p.Approvals > 0 && approver && !slices.Contains(is.Approvals, u.ID),
		"merge":   act && u.Can("issue.merge"), "delete": act && u.Can("issue.delete"),
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
