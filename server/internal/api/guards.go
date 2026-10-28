package api

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"multica/internal/store"
)

// Duas camadas decidem o que alguém pode fazer numa issue:
//  1. a permissão do perfil (global): issue.priority, issue.agent…
//  2. a política da etapa em que a issue está (por workspace): quem mexe nas
//     issues dali, quem pode trazer issues para lá, campos travados, requisitos,
//     limite de issues e aprovações.
// O dono passa por tudo. Ex.: estagiário e júnior com o mesmo perfil de
// permissões, mas a etapa "Triagem" só aceita o perfil Estagiário e
// "Desenvolvimento" só o Júnior: cada um mexe na sua.

func forbidden(format string, a ...any) error {
	return httpError{http.StatusForbidden, fmt.Sprintf(format, a...)}
}

// Campo da issue → permissão necessária e nome do campo para as travas da etapa.
var fieldRules = map[string]struct{ perm, lock, label string }{
	"title":       {"issue.edit", "title", "o título"},
	"description": {"issue.edit", "description", "a descrição"},
	"summary":     {"issue.edit", "description", "o README"},
	"priority":    {"issue.priority", "priority", "a prioridade"},
	"labelIds":    {"issue.labels", "labels", "as labels"},
	"agentId":     {"issue.agent", "agent", "o agente"},
	"skillIds":    {"issue.agent", "agent", "as skills"},
	"assigneeId":  {"issue.assign", "assignee", "o responsável"},
	"repos":       {"issue.repos", "repos", "os repositórios"},
	"status":      {"issue.move", "", "a etapa"},
	"position":    {"issue.move", "", "a ordem"},
}

func (a *API) policyOf(ctx context.Context, wsID, stage string) (*store.Stage, store.StagePolicy) {
	st, err := a.st.StageOf(ctx, wsID, stage)
	if err != nil {
		return nil, store.StagePolicy{}
	}
	return st, st.Policy
}

// whoText descreve um grupo para as mensagens de erro.
func (a *API) whoText(ctx context.Context, w store.Who) string {
	var parts []string
	if roles, err := a.st.ListRoles(ctx); err == nil {
		for _, r := range roles {
			if slices.Contains(w.Roles, r.ID) {
				parts = append(parts, "perfil "+r.Name)
			}
		}
	}
	for _, id := range w.Users {
		if u, err := a.st.UserByID(ctx, id); err == nil {
			parts = append(parts, u.Name)
		}
	}
	if len(parts) == 0 {
		return "outras pessoas"
	}
	return strings.Join(parts, ", ")
}

// canAct: a pessoa pode mexer nas issues da etapa atual.
func (a *API) canAct(ctx context.Context, u *store.User, is *store.Issue) error {
	st, p := a.policyOf(ctx, is.WorkspaceID, is.Status)
	if st != nil && p.ReadOnly && !u.IsOwner {
		return forbidden("%s é somente leitura: a issue não muda mais aqui", st.Name)
	}
	if st != nil && !p.Act.Includes(u) {
		return forbidden("na etapa %s, só %s mexe nas issues", st.Name, a.whoText(ctx, p.Act))
	}
	return nil
}

// need: permissão do perfil.
func need(u *store.User, perm, what string) error {
	if !u.Can(perm) {
		return forbidden("seu perfil não pode %s", what)
	}
	return nil
}

// canField: permissão do perfil + campo não travado na etapa.
func (a *API) canField(ctx context.Context, u *store.User, is *store.Issue, field string) error {
	fr, ok := fieldRules[field]
	if !ok {
		return nil
	}
	if !u.Can(fr.perm) {
		return forbidden("seu perfil não pode alterar %s", fr.label)
	}
	if fr.lock != "" && !u.IsOwner {
		if st, p := a.policyOf(ctx, is.WorkspaceID, is.Status); st != nil && slices.Contains(p.Locked, fr.lock) {
			return forbidden("na etapa %s, %s fica travado", st.Name, fr.label)
		}
	}
	return nil
}

// canEnter: a issue (já com os campos novos) pode entrar na etapa "to".
func (a *API) canEnter(ctx context.Context, u *store.User, is *store.Issue, to string) error {
	st, p := a.policyOf(ctx, is.WorkspaceID, to)
	if st == nil {
		return bad("etapa inválida")
	}
	if !p.Enter.Includes(u) {
		return forbidden("só %s pode trazer issues para %s", a.whoText(ctx, p.Enter), st.Name)
	}
	if p.WIP > 0 && is.Status != to && a.st.CountInStage(ctx, is.WorkspaceID, to) >= p.WIP {
		return bad("%s já tem o máximo de %d issues; termine alguma antes", st.Name, p.WIP)
	}
	return a.requirements(st, is)
}

func (a *API) requirements(st *store.Stage, is *store.Issue) error {
	for _, req := range st.Policy.Requires {
		switch req {
		case "agent":
			if is.AgentID == nil {
				return bad("para entrar em %s a issue precisa de um agente", st.Name)
			}
		case "assignee":
			if is.AssigneeID == nil {
				return bad("para entrar em %s a issue precisa de um responsável", st.Name)
			}
		case "description":
			if strings.TrimSpace(is.Description) == "" {
				return bad("para entrar em %s a issue precisa de descrição", st.Name)
			}
		case "changes":
			if !slices.ContainsFunc(is.Repos, func(r store.IssueRepo) bool { return r.Changed }) {
				return bad("para entrar em %s a issue precisa ter alterações de código", st.Name)
			}
		}
	}
	return nil
}

// checkAssignee: o responsável precisa ter acesso ao workspace.
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
		return bad("essa pessoa não tem acesso a este workspace")
	}
	return nil
}

// capsOf: o que a pessoa pode fazer nesta issue agora (a tela usa para
// esconder ou travar controles; o servidor confere de novo em cada ação).
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

// guardNewIssue: quem cria só define o que o perfil permite, e a etapa
// inicial precisa aceitar a pessoa (e os requisitos). Ex.: estagiário cria a
// issue, mas sem escolher agente nem prioridade.
func (a *API) guardNewIssue(ctx context.Context, u *store.User, wsID string, in *store.NewIssue) error {
	if in.AgentID != nil {
		if err := need(u, "issue.agent", "escolher o agente da issue"); err != nil {
			return err
		}
	}
	if in.Priority != 0 {
		if err := need(u, "issue.priority", "definir a prioridade"); err != nil {
			return err
		}
	}
	if len(in.LabelIDs) > 0 {
		if err := need(u, "issue.labels", "definir labels"); err != nil {
			return err
		}
	}
	if len(in.RepoIDs) > 0 {
		if err := need(u, "issue.repos", "escolher repositórios"); err != nil {
			return err
		}
	}
	if in.AssigneeID != nil && *in.AssigneeID != "" {
		if err := need(u, "issue.assign", "definir o responsável"); err != nil {
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
