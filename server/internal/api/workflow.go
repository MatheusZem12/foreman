package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"

	"multica/internal/store"
)

// Usuários e perfis são globais; o acesso a workspaces não. Toda referência a
// uma pessoa no fluxo (acesso a etapa, responsável, destinatário, aprovador)
// precisa ser de alguém com acesso ao workspace: o servidor recusa ao salvar,
// e a tela de fluxo alerta quando alguém perde o acesso depois.

// ---------- etapas ----------

func (a *API) listStages(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.Stages(r.Context(), chi.URLParam(r, "ws"))
}

// A etapa em si é só nome, posição e se fica em paralelo com a anterior; quem
// pode, travas e aprovação são regras de acesso. A cor sai da paleta sozinha.
type stageInput struct {
	Name     string `json:"name"`
	After    string `json:"after"`    // etapa depois da qual a nova entra
	Parallel *bool  `json:"parallel"` // ao lado da etapa anterior
}

var stagePalette = []string{"#a78bfa", "#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#a3e635", "#fb923c", "#94a3b8"}

// nextColor: a primeira cor da paleta que nenhuma etapa usa (ou a que se repete menos).
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

// checkWho: perfis existem e usuários têm acesso ao workspace.
func (a *API) checkWho(ctx context.Context, wsID string, w store.Who, what string) error {
	roles, err := a.st.ListRoles(ctx)
	if err != nil {
		return err
	}
	for _, id := range w.Roles {
		if !slices.ContainsFunc(roles, func(r store.Role) bool { return r.ID == id }) {
			return bad("%s: perfil inexistente", what)
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
			return bad("%s: %s não tem acesso a este workspace", what, name)
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
		return nil, bad("dê um nome à etapa")
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
		return nil, bad("envie a ordem de todas as etapas")
	}
	for _, s := range all {
		if !slices.Contains(in.IDs, s.ID) {
			return nil, bad("etapa faltando na ordem: %s", s.Name)
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
		return nil, bad("o fluxo precisa de pelo menos uma etapa")
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

// ruleConfig é a parte da config que o servidor confere.
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
		return bad("gatilho desconhecido")
	}
	if in.Trigger == "access" {
		return a.checkAccess(ctx, in)
	}
	if !store.RuleActions[in.Action] {
		return bad("ação desconhecida")
	}
	if store.TriggerNeedsStage(in.Trigger) {
		if !a.st.ValidStage(ctx, in.WorkspaceID, in.Stage) {
			return bad("escolha a etapa do gatilho")
		}
	} else {
		in.Stage = ""
	}
	var cond store.Conditions
	if len(in.Conditions) > 0 && json.Unmarshal(in.Conditions, &cond) != nil {
		return bad("condições inválidas")
	}
	for _, st := range cond.Stages {
		if !a.st.ValidStage(ctx, in.WorkspaceID, st) {
			return bad("etapa inválida nos filtros")
		}
	}
	if in.Trigger == "stale" && cond.Hours <= 0 {
		return bad("informe depois de quantas horas parada")
	}
	if in.Trigger == "cost_over" && cond.Cost <= 0 {
		return bad("informe o valor em US$")
	}
	var c ruleConfig
	if len(in.Config) > 0 && json.Unmarshal(in.Config, &c) != nil {
		return bad("configuração inválida")
	}
	who := store.Who{Roles: c.Roles, Users: c.Users}
	switch in.Action {
	case "notify":
		if !notifyTargets[c.To] {
			return bad("escolha para quem notificar")
		}
		if c.To == "roles" && len(c.Roles) == 0 || c.To == "users" && len(c.Users) == 0 {
			return bad("escolha ao menos um perfil ou usuário")
		}
		if err := a.checkWho(ctx, in.WorkspaceID, who, "Destinatários"); err != nil {
			return err
		}
	case "assign":
		if (c.Mode == "" || c.Mode == "user") && len(c.Users) == 0 || c.Mode == "balance" && who.Empty() {
			return bad("escolha quem vai ser o responsável")
		}
		if err := a.checkWho(ctx, in.WorkspaceID, who, "Responsável"); err != nil {
			return err
		}
	case "move":
		if c.To == "" || (store.TriggerNeedsStage(in.Trigger) && c.To == in.Stage) || !a.st.ValidStage(ctx, in.WorkspaceID, c.To) {
			return bad("escolha a etapa de destino (diferente da do gatilho)")
		}
	case "webhook":
		if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
			return bad("informe a URL do webhook (http/https)")
		}
	case "script":
		if strings.TrimSpace(c.Script) == "" {
			return bad("escreva o script")
		}
	case "set_agent":
		if _, err := a.st.Agent(ctx, c.AgentID); err != nil {
			return bad("escolha o agente")
		}
	case "add_label":
		l, err := a.st.Label(ctx, c.LabelID)
		if err != nil || l.WorkspaceID != in.WorkspaceID {
			return bad("escolha uma label deste workspace")
		}
	case "comment":
		if strings.TrimSpace(c.Message) == "" {
			return bad("escreva o comentário")
		}
	}
	if c.OnFail != "" && !a.st.ValidStage(ctx, in.WorkspaceID, c.OnFail) {
		return bad("etapa de falha inválida")
	}
	if c.OnWait != "" && !a.st.ValidStage(ctx, in.WorkspaceID, c.OnWait) {
		return bad("etapa inválida")
	}
	return nil
}

var lockFields = []string{"title", "description", "priority", "labels", "agent", "repos", "assignee"}
var requirements = []string{"agent", "assignee", "description", "changes"}

// checkAccess: regra de acesso (quem pode, travas, requisitos, limite,
// aprovação, responsáveis) de uma etapa. Não tem filtros: vale sempre.
func (a *API) checkAccess(ctx context.Context, in *store.Rule) error {
	if !store.AccessActions[in.Action] {
		return bad("ação desconhecida")
	}
	if !a.st.ValidStage(ctx, in.WorkspaceID, in.Stage) {
		return bad("escolha a etapa")
	}
	in.Conditions = json.RawMessage("{}")
	var c store.AccessConfig
	if len(in.Config) > 0 && json.Unmarshal(in.Config, &c) != nil {
		return bad("configuração inválida")
	}
	who := store.Who{Roles: c.Roles, Users: c.Users}
	switch in.Action {
	case "allow_act", "allow_enter", "responsible":
		if who.Empty() {
			return bad("escolha ao menos um perfil ou pessoa")
		}
	case "lock_fields":
		if len(c.Fields) == 0 || slices.ContainsFunc(c.Fields, func(f string) bool { return !slices.Contains(lockFields, f) }) {
			return bad("escolha o que fica travado")
		}
	case "require":
		if len(c.Requires) == 0 || slices.ContainsFunc(c.Requires, func(f string) bool { return !slices.Contains(requirements, f) }) {
			return bad("escolha o que a issue precisa ter")
		}
	case "wip":
		if c.WIP < 1 {
			return bad("informe o limite de issues")
		}
	case "close":
		if c.Kind != "done" && c.Kind != "cancelled" {
			return bad("escolha se a issue fica concluída ou cancelada")
		}
	case "approval":
		if c.Approvals < 1 || c.Approvals > 10 {
			return bad("de 1 a 10 aprovações")
		}
		if c.To == "" || c.To == in.Stage || !a.st.ValidStage(ctx, in.WorkspaceID, c.To) {
			return bad("escolha para onde a issue vai quando aprovada")
		}
	}
	return a.checkWho(ctx, in.WorkspaceID, who, "Pessoas da regra")
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

// orderRules grava a ordem em que as regras rodam (uma lista de ids).
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
	"allow_act": "quem mexe", "allow_enter": "quem traz issues", "read_only": "somente leitura", "lock_fields": "campos travados",
	"require": "requisitos", "wip": "limite de issues", "approval": "aprovação", "responsible": "responsáveis",
	"notify": "notificar", "webhook": "webhook", "move": "mover", "run_agent": "rodar agente", "open_pr": "abrir PR", "merge": "merge",
	"script": "script", "set_agent": "definir agente", "set_priority": "definir prioridade", "add_label": "adicionar label",
	"assign": "definir responsável", "comment": "comentar", "stop_agent": "parar o agente", "close": "encerrar a issue",
}

type warning struct {
	Where   string `json:"where"`
	Message string `json:"message"`
	StageID string `json:"stageId,omitempty"`
	RuleID  string `json:"ruleId,omitempty"`
}

// workflowWarnings: referências a pessoas sem acesso, perfis ou labels que
// sumiram, agentes arquivados. Usado na tela de fluxo e na duplicação.
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
		return tr(ctx, "usuário removido")
	}
	checkWho := func(w store.Who, where, stageID, ruleID string) {
		for _, id := range w.Users {
			if !access[id] {
				out = append(out, warning{where, tr(ctx, "%s não tem acesso a este workspace", name(id)), stageID, ruleID})
			}
		}
		for _, id := range w.Roles {
			if !slices.ContainsFunc(roles, func(r store.Role) bool { return r.ID == id }) {
				out = append(out, warning{where, tr(ctx, "um perfil usado aqui foi excluído"), stageID, ruleID})
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
		where := tr(ctx, "Regra %s", tr(ctx, firstNonEmptyStr(actionNames[r.Action], r.Action)))
		if r.Stage != "" {
			where = tr(ctx, "Etapa %s · %s", stageName(r.Stage), tr(ctx, firstNonEmptyStr(actionNames[r.Action], r.Action)))
		}
		checkWho(store.Who{Roles: c.Roles, Users: c.Users}, where, "", r.ID)
		if c.LabelID != "" {
			if l, err := a.st.Label(ctx, c.LabelID); err != nil || l.WorkspaceID != wsID {
				out = append(out, warning{where, tr(ctx, "a label desta regra não existe neste workspace"), "", r.ID})
			}
		}
		if c.AgentID != "" {
			if ag, err := a.st.Agent(ctx, c.AgentID); err != nil || ag.Archived {
				out = append(out, warning{where, tr(ctx, "o agente desta regra foi arquivado"), "", r.ID})
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

// copyWorkflow copia etapas e regras (inclusive as de acesso) para outro workspace.
// Pessoas sem acesso ao destino saem das listas; labels são recriadas pelo
// nome; regras que ficariam sem efeito vão desativadas. dryRun só devolve
// os alertas, para a pessoa decidir antes de confirmar.
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
		return nil, bad("escolha outro workspace de destino")
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
	access, _ := a.st.WorkspaceUserIDs(ctx, in.To)
	users, _ := a.st.ListUsers(ctx)
	name := func(id string) string {
		for _, u := range users {
			if u.ID == id {
				return u.Name
			}
		}
		return tr(ctx, "usuário removido")
	}
	warns := []warning{}
	strip := func(ids []string, where string) []string {
		kept := ids[:0:0]
		for _, id := range ids {
			if access[id] {
				kept = append(kept, id)
			} else {
				warns = append(warns, warning{Where: where, Message: tr(ctx, "%s não tem acesso ao destino e sai da lista", name(id))})
			}
		}
		return kept
	}
	destLabels, _ := a.st.ListLabels(ctx, in.To)
	for i := range rules {
		rl := &rules[i]
		var c map[string]any
		json.Unmarshal(rl.Config, &c)
		where := tr(ctx, "Regra %s", tr(ctx, firstNonEmptyStr(actionNames[rl.Action], rl.Action)))
		if list, ok := c["users"].([]any); ok {
			var ids []string
			for _, v := range list {
				ids = append(ids, fmt.Sprint(v))
			}
			kept := strip(ids, where)
			c["users"] = kept
			roles, _ := c["roles"].([]any)
			// Regra de acesso que ficaria sem ninguém liberaria a etapa para todos.
			needsUsers := (rl.Action == "notify" && c["to"] == "users") || (rl.Action == "assign" && (c["mode"] == nil || c["mode"] == "" || c["mode"] == "user")) ||
				(rl.Trigger == "access" && slices.Contains([]string{"allow_act", "allow_enter", "responsible"}, rl.Action) && len(roles) == 0)
			if needsUsers && len(kept) == 0 && rl.Enabled {
				rl.Enabled = false
				warns = append(warns, warning{Where: where, Message: tr(ctx, "ficou sem ninguém e vai desativada; escolha pessoas do destino")})
			}
		}
		if lid, _ := c["labelId"].(string); lid != "" {
			if l, err := a.st.Label(ctx, lid); err == nil {
				idx := slices.IndexFunc(destLabels, func(x store.Label) bool { return strings.EqualFold(x.Name, l.Name) })
				switch {
				case idx >= 0:
					c["labelId"] = destLabels[idx].ID
				case in.DryRun:
					warns = append(warns, warning{Where: where, Message: tr(ctx, "a label %s será criada no destino", l.Name)})
				default:
					if nl, err := a.st.CreateLabel(ctx, in.To, l.Name, l.Color); err == nil {
						c["labelId"] = nl.ID
						destLabels = append(destLabels, *nl)
					}
				}
			}
		}
		rl.Config, _ = json.Marshal(c)
	}
	if in.DryRun {
		return map[string]any{"warnings": warns, "stages": len(stages), "rules": len(rules)}, nil
	}
	if err := a.st.ReplaceWorkflow(ctx, in.To, stages, rules); err != nil {
		return nil, err
	}
	return map[string]any{"warnings": warns, "stages": len(stages), "rules": len(rules)}, nil
}

// ---------- aprovar ----------

// approveIssue registra a aprovação da pessoa na etapa atual. Quando atinge
// o número que a etapa pede, a issue segue para o destino da aprovação.
func (a *API) approveIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	is, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	u := userOf(r)
	st, p := a.policyOf(ctx, is.WorkspaceID, is.Status)
	if st == nil || p.Approvals <= 0 {
		return nil, bad("esta etapa não tem aprovação")
	}
	if p.ReadOnly && !u.IsOwner {
		return nil, forbidden("%s é somente leitura", st.Name)
	}
	if !u.IsOwner {
		if err := need(u, "issue.approve", "aprovar issues"); err != nil {
			return nil, err
		}
		if !p.Approvers.Empty() && !p.Approvers.Includes(u) {
			return nil, forbidden("em %s, só %s aprova", st.Name, a.whoText(ctx, p.Approvers))
		}
	}
	if is.ActiveRun != nil {
		return nil, bad("espere a execução terminar para aprovar")
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
		a.run.SystemComment(ctx, is, fmt.Sprintf("✓ %s aprovou (%d de %d).", u.Name, n, p.Approvals))
	}
	is, _ = a.st.Issue(ctx, is.ID)
	a.publishIssue(is)
	return map[string]any{"issue": is, "approvals": n, "needed": p.Approvals}, nil
}

// ---------- entrada de issues por webhook ----------

func (a *API) getIntake(w http.ResponseWriter, r *http.Request) (any, error) {
	ws, err := a.st.Workspace(r.Context(), chi.URLParam(r, "ws"))
	if err != nil {
		return nil, err
	}
	out := map[string]any{"enabled": ws.IntakeToken != nil, "stage": ws.IntakeStage}
	if ws.IntakeToken != nil {
		out["path"] = "/api/hooks/" + *ws.IntakeToken
	}
	return out, nil
}

func (a *API) saveIntake(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	wsID := chi.URLParam(r, "ws")
	var in struct {
		Enabled bool   `json:"enabled"`
		Stage   string `json:"stage"`
		Rotate  bool   `json:"rotate"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	ws, err := a.st.Workspace(ctx, wsID)
	if err != nil {
		return nil, err
	}
	if in.Stage == "" {
		in.Stage = a.st.FirstStage(ctx, wsID)
	}
	if !a.st.ValidStage(ctx, wsID, in.Stage) {
		return nil, bad("etapa inválida")
	}
	token := ws.IntakeToken
	switch {
	case !in.Enabled:
		token = nil
	case token == nil || in.Rotate:
		b := make([]byte, 20)
		rand.Read(b)
		t := hex.EncodeToString(b)
		token = &t
	}
	if _, err := a.st.SetIntake(ctx, wsID, token, in.Stage); err != nil {
		return nil, err
	}
	return a.getIntake(w, r)
}

// intakeHook cria uma issue a partir de um POST externo (formulário, n8n,
// e-mail encaminhado por Cloudflare Email Routing, Zapier…). Sem login: o
// token do endereço é a credencial. Aceita {title, description, priority} ou
// o formato de e-mail {subject, text|body, from}.
func (a *API) intakeHook(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	ws, err := a.st.WorkspaceByIntake(ctx, chi.URLParam(r, "token"))
	if err != nil {
		return nil, store.ErrNotFound
	}
	var in struct {
		Title, Description, Subject, Text, Body, From string
		Priority                                      int16
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in); err != nil {
		return nil, bad("envie JSON: {title, description, priority} ou {subject, text, from}")
	}
	title := strings.TrimSpace(firstNonEmptyStr(in.Title, in.Subject))
	if title == "" {
		return nil, bad("faltou o título (title ou subject)")
	}
	desc := strings.TrimSpace(firstNonEmptyStr(in.Description, in.Text, in.Body))
	if in.From != "" {
		desc = strings.TrimSpace(desc + "\n\n— recebido de " + in.From)
	}
	if in.Priority < 0 || in.Priority > 4 {
		in.Priority = 0
	}
	is, err := a.st.CreateIssue(ctx, ws.ID, "", store.NewIssue{Title: title, Description: desc, Status: ws.IntakeStage, Priority: in.Priority})
	if err != nil {
		return nil, err
	}
	a.publishIssue(is)
	return map[string]any{"ref": fmt.Sprintf("%s-%d", ws.Key, is.Number), "id": is.ID}, nil
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

// ---------- perfil de uma pessoa ----------

type profileWorkspace struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Key      string   `json:"key"`
	Roles    []string `json:"roles"`    // o que faz em cada etapa (ex.: "Triagem: mexe nas issues, aprova")
	Rules    int      `json:"rules"`    // regras que citam a pessoa (destinatário, responsável)
	Open     int      `json:"open"`     // issues abertas com ela de responsável
	Created  int      `json:"created"`  // issues que ela criou
	Resolved int      `json:"resolved"` // com ela de responsável, concluídas
}

// userProfile: quem a pessoa é e o que faz em cada workspace que quem
// pergunta também enxerga.
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
					parts = append(parts, tr(ctx, "mexe nas issues"))
				}
				if pol.Enter.Has(target) {
					parts = append(parts, tr(ctx, "traz issues"))
				}
				if pol.Approvals > 0 && pol.Approvers.Has(target) {
					parts = append(parts, tr(ctx, "aprova"))
				}
				if pol.Responsible.Has(target) {
					parts = append(parts, tr(ctx, "é responsável"))
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
