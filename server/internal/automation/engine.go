// Package automation roda as regras do fluxo. Gatilhos: entrar ou sair de uma
// etapa, ficar parada nela, issue criada, comentário, execução terminada,
// responsável ou prioridade trocados e custo acima de um valor. Cada regra
// pode ter condições (prioridade, labels, agente, resultado, perfil de quem
// causou) e faz uma ação. Cada ação vira um comentário de sistema na issue.
package automation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"multica/internal/notify"
	"multica/internal/runner"
	"multica/internal/store"
)

type Engine struct {
	st  *store.Store
	run *runner.Runner
	ntf *notify.Notifier

	mu    sync.Mutex
	moves map[string][]time.Time // issue → mudanças recentes feitas por regras (anti-loop)
}

func New(st *store.Store, run *runner.Runner, ntf *notify.Notifier) *Engine {
	e := &Engine{st: st, run: run, ntf: ntf, moves: map[string][]time.Time{}}
	st.OnEvent = e.handle
	return e
}

// Start liga a varredura dos gatilhos por tempo (parada na etapa, custo).
func (e *Engine) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				e.sweep(ctx)
			}
		}
	}()
}

// Config de cada ação (o JSON salvo em rules.config).
type Config struct {
	To       string   `json:"to,omitempty"`       // notify: creator|requester|assignee|responsible|team|admins|roles|users; move: etapa
	Roles    []string `json:"roles,omitempty"`    // notify/assign: perfis
	Users    []string `json:"users,omitempty"`    // notify/assign: usuários
	Message  string   `json:"message,omitempty"`  // notify/webhook/comment
	URL      string   `json:"url,omitempty"`      // webhook
	AgentID  string   `json:"agentId,omitempty"`  // run_agent/set_agent
	Request  string   `json:"request,omitempty"`  // run_agent
	Base     string   `json:"base,omitempty"`     // open_pr/merge
	Draft    bool     `json:"draft,omitempty"`    // open_pr
	Script   string   `json:"script,omitempty"`   // script
	OnFail   string   `json:"onFail,omitempty"`   // etapa para onde mandar se falhar
	Priority *int     `json:"priority,omitempty"` // set_priority
	LabelID  string   `json:"labelId,omitempty"`  // add_label
	Mode     string   `json:"mode,omitempty"`     // assign: user|creator|requester|balance
}

const maxAutoMoves = 8 // por issue, por minuto

func (e *Engine) handle(ev store.Event) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Hour)
		defer cancel()
		defer func() {
			if p := recover(); p != nil {
				log.Printf("automação: pânico em %s: %v", ev.IssueID, p)
			}
		}()
		is, err := e.st.Issue(ctx, ev.IssueID)
		if err != nil {
			return
		}
		switch ev.Kind {
		case "stage":
			if ev.From != "" {
				e.fire(ctx, is, ev, "leave", ev.From)
			}
			if cur, err := e.st.Issue(ctx, is.ID); err == nil && cur.Status == ev.To {
				e.fire(ctx, cur, ev, "enter", ev.To)
			}
		default:
			e.fire(ctx, is, ev, ev.Kind, "")
		}
	}()
}

// sweep: gatilhos por tempo e por limite, uma vez por regra e issue.
func (e *Engine) sweep(ctx context.Context) {
	if rules, err := e.st.RulesByTrigger(ctx, "stale"); err == nil {
		for _, r := range rules {
			var c store.Conditions
			json.Unmarshal(r.Conditions, &c)
			if c.Hours <= 0 {
				continue
			}
			issues, _ := e.st.StaleIssues(ctx, r.WorkspaceID, r.Stage, c.Hours)
			for i := range issues {
				if e.matches(ctx, &issues[i], c, store.Event{}) && e.st.MarkFired(ctx, r.ID, issues[i].ID) {
					e.runRule(ctx, &issues[i], store.Event{Kind: "stale", To: r.Stage}, r)
				}
			}
		}
	}
	if rules, err := e.st.RulesByTrigger(ctx, "cost_over"); err == nil {
		for _, r := range rules {
			var c store.Conditions
			json.Unmarshal(r.Conditions, &c)
			if c.Cost <= 0 {
				continue
			}
			issues, _ := e.st.CostlyIssues(ctx, r.WorkspaceID, c.Cost)
			for i := range issues {
				if e.matches(ctx, &issues[i], c, store.Event{}) && e.st.MarkFired(ctx, r.ID, issues[i].ID) {
					e.runRule(ctx, &issues[i], store.Event{Kind: "cost_over"}, r)
				}
			}
		}
	}
}

func (e *Engine) fire(ctx context.Context, is *store.Issue, ev store.Event, trigger, stage string) {
	rules, err := e.st.RulesFor(ctx, is.WorkspaceID, trigger, stage)
	if err != nil {
		return
	}
	for _, r := range rules {
		var c store.Conditions
		json.Unmarshal(r.Conditions, &c)
		cur, err := e.st.Issue(ctx, is.ID)
		if err != nil {
			return
		}
		// Ao entrar: uma regra anterior pode ter tirado a issue da etapa.
		if trigger == "enter" && cur.Status != stage {
			return
		}
		if !e.matches(ctx, cur, c, ev) {
			continue
		}
		if stop := e.runRule(ctx, cur, ev, r); stop {
			return
		}
	}
}

// matches confere as condições da regra.
func (e *Engine) matches(ctx context.Context, is *store.Issue, c store.Conditions, ev store.Event) bool {
	if len(c.Priorities) > 0 && !slices.Contains(c.Priorities, int(is.Priority)) {
		return false
	}
	if len(c.Labels) > 0 && !slices.ContainsFunc(c.Labels, func(l string) bool { return slices.Contains(is.LabelIDs, l) }) {
		return false
	}
	if len(c.Agents) > 0 && (is.AgentID == nil || !slices.Contains(c.Agents, *is.AgentID)) {
		return false
	}
	if len(c.Outcomes) > 0 && ev.Kind == "run_finished" && !slices.Contains(c.Outcomes, ev.Outcome) {
		return false
	}
	if len(c.ActorRoles) > 0 {
		if ev.ActorID == nil {
			return false
		}
		u, err := e.st.UserByID(ctx, *ev.ActorID)
		if err != nil || u.RoleID == nil || !slices.Contains(c.ActorRoles, *u.RoleID) {
			return false
		}
	}
	return true
}

// runRule aplica a regra e registra; true = parar as regras seguintes.
func (e *Engine) runRule(ctx context.Context, is *store.Issue, ev store.Event, r store.Rule) bool {
	var cfg Config
	json.Unmarshal(r.Config, &cfg)
	label := firstNonEmpty(r.Name, actionLabel(r.Action))
	msg, err := e.apply(ctx, is, ev, r.Action, cfg)
	switch {
	case errors.Is(err, errSkip):
		return false
	case errors.Is(err, errStop):
		return true
	case err != nil:
		e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Regra **%s** (%s) falhou: %s", label, e.triggerText(ctx, is, r), err))
		if cfg.OnFail != "" && cfg.OnFail != is.Status && e.st.ValidStage(ctx, is.WorkspaceID, cfg.OnFail) {
			e.move(ctx, is, cfg.OnFail)
		}
		return true
	case msg != "":
		e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Regra **%s**: %s", label, msg))
	}
	return false
}

func (e *Engine) triggerText(ctx context.Context, is *store.Issue, r store.Rule) string {
	st := e.st.StageName(ctx, is.WorkspaceID, r.Stage)
	return map[string]string{
		"enter": "ao entrar em " + st, "leave": "ao sair de " + st, "stale": "parada em " + st,
		"created": "issue criada", "commented": "comentário", "run_finished": "execução terminou",
		"cost_over": "custo passou do limite", "assigned": "responsável definido", "priority_changed": "prioridade trocada",
	}[r.Trigger]
}

var errSkip = errors.New("nada a fazer")

func actionLabel(a string) string {
	return map[string]string{
		"notify": "Notificar", "webhook": "Webhook", "move": "Mover", "run_agent": "Rodar agente",
		"open_pr": "Abrir PR", "merge": "Merge", "script": "Script", "set_agent": "Definir agente",
		"set_priority": "Definir prioridade", "add_label": "Adicionar label", "assign": "Definir responsável", "comment": "Comentar",
	}[a]
}

var priorityName = []string{"Sem prioridade", "Urgente", "Alta", "Média", "Baixa"}

func (e *Engine) apply(ctx context.Context, is *store.Issue, ev store.Event, action string, cfg Config) (string, error) {
	ws, err := e.st.Workspace(ctx, is.WorkspaceID)
	if err != nil {
		return "", err
	}
	ref := fmt.Sprintf("%s-%d", ws.Key, is.Number)
	stage := e.st.StageName(ctx, is.WorkspaceID, is.Status)

	switch action {
	case "notify":
		to, who := e.recipients(ctx, is, cfg)
		headline := e.headline(ref, stage, is, ev)
		note := strings.TrimSpace(cfg.Message)
		if is.Status == "waiting" || is.Status == "blocked" || ev.Kind == "run_finished" {
			if n := e.lastOutcomeNote(ctx, is.ID); n != "" {
				note = strings.TrimSpace(note + "\n\n" + n)
			}
		}
		if err := e.ntf.StageEmail(ctx, is, to, headline, note); err != nil {
			if errors.Is(err, notify.ErrDisabled) {
				return "", errSkip // e-mail desligado no servidor: a tela de fluxo avisa
			}
			return "", err
		}
		return fmt.Sprintf("e-mail enviado para %s.", who), nil

	case "webhook":
		text := fmt.Sprintf("%s · %s → %s", ref, is.Title, stage)
		return e.webhook(ctx, cfg, map[string]any{
			"event": "issue." + ev.Kind, "workspace": ws.Name, "ref": ref, "title": is.Title, "priority": is.Priority,
			"from": ev.From, "to": ev.To, "stage": stage, "branch": is.Branch, "message": cfg.Message,
			"text": text, "content": text, // Slack/Discord/Teams mostram direto
		})

	case "move":
		if cfg.To == "" || cfg.To == is.Status || !e.st.ValidStage(ctx, is.WorkspaceID, cfg.To) {
			return "", errSkip
		}
		if !e.move(ctx, is, cfg.To) {
			return "", errors.New("muitas mudanças automáticas seguidas; parei para não entrar em loop")
		}
		return "movida para " + e.st.StageName(ctx, is.WorkspaceID, cfg.To) + ".", nil

	case "run_agent":
		kind, request := "followup", strings.TrimSpace(cfg.Request)
		if request == "" {
			kind = "initial"
		}
		// Gatilho sem etapa (issue criada, comentário…): pedido normal ao agente.
		if !store.TriggerNeedsStage(ev.Kind) && ev.Kind != "stage" {
			if _, err := e.run.Enqueue(ctx, is, cfg.AgentID, kind, request, nil); err != nil {
				return "", err
			}
			return "pedido enviado ao agente.", nil
		}
		return e.agentStep(ctx, is, cfg, kind, request)

	case "set_agent":
		if cfg.AgentID == "" || (is.AgentID != nil && *is.AgentID == cfg.AgentID) {
			return "", errSkip
		}
		a, err := e.st.Agent(ctx, cfg.AgentID)
		if err != nil {
			return "", errors.New("agente não encontrado")
		}
		e.patch(ctx, is, map[string]any{"agentId": a.ID})
		return "agente definido: " + a.Name + ".", nil

	case "set_priority":
		if cfg.Priority == nil || int(is.Priority) == *cfg.Priority || *cfg.Priority < 0 || *cfg.Priority > 4 {
			return "", errSkip
		}
		e.patch(ctx, is, map[string]any{"priority": float64(*cfg.Priority)})
		return "prioridade: " + priorityName[*cfg.Priority] + ".", nil

	case "add_label":
		if cfg.LabelID == "" || slices.Contains(is.LabelIDs, cfg.LabelID) {
			return "", errSkip
		}
		l, err := e.st.Label(ctx, cfg.LabelID)
		if err != nil || l.WorkspaceID != is.WorkspaceID {
			return "", errors.New("label não existe neste workspace")
		}
		labels := []any{}
		for _, id := range append(slices.Clone(is.LabelIDs), l.ID) {
			labels = append(labels, id)
		}
		e.patch(ctx, is, map[string]any{"labelIds": labels})
		return "label " + l.Name + " adicionada.", nil

	case "assign":
		u, err := e.pickAssignee(ctx, is, cfg)
		if err != nil {
			return "", err
		}
		if is.AssigneeID != nil && *is.AssigneeID == u.ID {
			return "", errSkip
		}
		e.patch(ctx, is, map[string]any{"assigneeId": u.ID})
		return "responsável: " + u.Name + ".", nil

	case "comment":
		if strings.TrimSpace(cfg.Message) == "" {
			return "", errSkip
		}
		return strings.TrimSpace(cfg.Message), nil

	case "open_pr":
		urls, err := e.run.OpenPRs(ctx, is, ref, cfg.Base, cfg.Draft)
		if len(urls) == 0 && err != nil && err.Error() == "nenhum repositório alterado" {
			return "", errSkip
		}
		msg := ""
		if len(urls) > 0 {
			msg = "PR aberto — " + strings.Join(urls, "; ")
		}
		return msg, err

	case "merge":
		scope, err := e.st.IssueRepos(ctx, is.ID)
		if err != nil {
			return "", err
		}
		targets := map[string]string{}
		pending := 0
		for _, sc := range scope {
			if sc.IssueRepo.Changed && sc.IssueRepo.MergedInto == "" {
				pending++
				if cfg.Base != "" {
					targets[sc.ID] = cfg.Base
				}
			}
		}
		if pending == 0 {
			return "", errSkip // nada alterado ou já mesclado (ex.: merge feito pelo botão)
		}
		res, err := e.run.Merge(ctx, is, targets, &store.User{Name: "Multica"})
		if err != nil {
			return "", err
		}
		if res.Conflict {
			return "", errors.New("conflito; nada foi publicado. A issue foi para Bloqueada: use \"Resolver conflito com IA\"")
		}
		var parts []string
		for _, m := range res.Repos {
			parts = append(parts, fmt.Sprintf("%s → %s (%s)", m.Name, m.Target, m.SHA))
		}
		return "merge feito: " + strings.Join(parts, ", ") + ".", nil

	case "script":
		if strings.TrimSpace(cfg.Script) == "" {
			return "", errSkip
		}
		out, err := e.run.RunScript(ctx, is.ID, cfg.Script, []string{
			"MULTICA_ISSUE=" + ref, "MULTICA_TITLE=" + is.Title, "MULTICA_BRANCH=" + is.Branch,
			"MULTICA_STAGE=" + is.Status, "MULTICA_FROM=" + ev.From, "MULTICA_EVENT=" + ev.Kind,
			"MULTICA_README=" + e.run.ReadmePath(is.ID), "MULTICA_WORKSPACE=" + ws.Key,
			fmt.Sprintf("MULTICA_PRIORITY=%d", is.Priority),
		})
		block := ""
		if out != "" {
			block = "\n```\n" + out + "\n```"
		}
		if err != nil {
			return "", fmt.Errorf("%v%s", err, block)
		}
		return "script rodou." + block, nil
	}
	return "", fmt.Errorf("ação desconhecida %q", action)
}

func (e *Engine) headline(ref, stage string, is *store.Issue, ev store.Event) string {
	switch ev.Kind {
	case "created":
		return fmt.Sprintf("Nova issue %s (%s)", ref, priorityName[min(max(int(is.Priority), 0), 4)])
	case "commented":
		return fmt.Sprintf("Novo comentário em %s", ref)
	case "run_finished":
		return fmt.Sprintf("O agente terminou %s: %s", ref, map[string]string{
			"done": "concluído", "waiting": "aguardando você", "incomplete": "incompleto", "failed": "falhou"}[ev.Outcome])
	case "stale":
		return fmt.Sprintf("%s está parada em %s", ref, stage)
	case "cost_over":
		return fmt.Sprintf("%s passou do limite de custo", ref)
	case "assigned":
		return fmt.Sprintf("Você é responsável por %s", ref)
	case "priority_changed":
		return fmt.Sprintf("%s agora é %s", ref, priorityName[min(max(int(is.Priority), 0), 4)])
	}
	if is.Status == "waiting" {
		return fmt.Sprintf("%s precisa de você", ref)
	}
	if ev.Kind == "stage" && ev.From == is.Status {
		return fmt.Sprintf("%s saiu de %s", ref, stage)
	}
	return fmt.Sprintf("%s entrou em %s", ref, stage)
}

// errStop encerra a sequência da etapa sem tratar como falha da regra.
var errStop = errors.New("sequência encerrada")

// agentStep: passo de etapa que roda o agente e ESPERA terminar. A issue fica
// na etapa enquanto isso. Concluído → segue para a próxima regra; aguardando
// ou incompleto → Aguardando você (a sequência para); falha → erro da regra
// (vai para "se falhar", ou Bloqueada).
func (e *Engine) agentStep(ctx context.Context, is *store.Issue, cfg Config, kind, request string) (string, error) {
	run, err := e.run.EnqueueInStage(ctx, is, cfg.AgentID, kind, request)
	if err != nil {
		return "", err
	}
	e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Passo da etapa: %s está trabalhando; as próximas regras rodam quando terminar.", run.AgentName))
	deadline := time.Now().Add(3 * time.Hour)
	for {
		select {
		case <-ctx.Done():
			return "", errors.New("o agente passou do tempo limite do passo")
		case <-time.After(2 * time.Second):
		}
		cur, err := e.st.Run(ctx, run.ID)
		if err != nil {
			return "", err
		}
		switch cur.Status {
		case "queued", "running":
			if time.Now().After(deadline) {
				return "", errors.New("o agente passou de 3 horas")
			}
			continue
		case "cancelled":
			return "", errStop
		case "failed":
			if cfg.OnFail == "" {
				e.move(ctx, is, "blocked")
			}
			return "", fmt.Errorf("o agente falhou: %s", firstNonEmpty(cur.Error, "sem detalhes"))
		}
		if cur.Outcome == "waiting" || cur.Outcome == "incomplete" {
			e.move(ctx, is, "waiting")
			return "", errStop
		}
		note := ""
		if cur.OutcomeNote != "" {
			note = ": " + cur.OutcomeNote
		}
		return fmt.Sprintf("%s terminou%s.", cur.AgentName, note), nil
	}
}

// patch altera campos da issue como o Multica (dispara os eventos de cada campo).
func (e *Engine) patch(ctx context.Context, is *store.Issue, fields map[string]any) {
	if updated, err := e.st.PatchIssue(ctx, is.ID, fields); err == nil {
		*is = *updated
		e.run.PublishIssue(ctx, is.ID)
	}
}

// move muda a etapa por regra, com limite contra loops (A→B→A…).
func (e *Engine) move(ctx context.Context, is *store.Issue, to string) bool {
	e.mu.Lock()
	now := time.Now()
	recent := e.moves[is.ID][:0]
	for _, t := range e.moves[is.ID] {
		if now.Sub(t) < time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= maxAutoMoves {
		e.moves[is.ID] = recent
		e.mu.Unlock()
		return false
	}
	e.moves[is.ID] = append(recent, now)
	e.mu.Unlock()
	if to == "cancelled" || to == "backlog" {
		if run, err := e.st.ActiveRun(ctx, is.ID); err == nil {
			e.run.Cancel(ctx, run.ID)
		}
	}
	e.st.SetIssueStatus(ctx, is.ID, to)
	e.run.PublishIssue(ctx, is.ID)
	// Entrar em "A fazer" com agente inicia a execução, como no quadro.
	if to == "todo" && is.AgentID != nil {
		if fresh, err := e.st.Issue(ctx, is.ID); err == nil && fresh.ActiveRun == nil {
			e.run.Enqueue(ctx, fresh, "", "initial", "", nil)
		}
	}
	return true
}

// ---------- pessoas ----------

// members: quem tem acesso ao workspace (só elas recebem e-mail ou viram responsáveis).
func (e *Engine) members(ctx context.Context, wsID string) []store.Member {
	ms, _ := e.st.ListMembers(ctx, wsID)
	return ms
}

func isAdmin(u store.User) bool {
	return u.IsOwner || slices.Contains(u.Permissions, "*") || slices.Contains(u.Permissions, "workflow.manage")
}

func (e *Engine) requester(ctx context.Context, is *store.Issue) *string {
	if runs, err := e.st.ListRuns(ctx, is.ID); err == nil {
		for i := len(runs) - 1; i >= 0; i-- {
			if runs[i].CreatedBy != nil {
				return runs[i].CreatedBy
			}
		}
	}
	return is.CreatedBy
}

// recipients resolve o grupo de destino em e-mails de quem tem acesso ao workspace.
func (e *Engine) recipients(ctx context.Context, is *store.Issue, cfg Config) ([]string, string) {
	ms := e.members(ctx, is.WorkspaceID)
	pick := func(keep func(store.Member) bool, broadcast bool) []string {
		var out []string
		for _, m := range ms {
			if keep(m) && (!broadcast || m.EmailNotifications) {
				out = append(out, m.Email)
			}
		}
		return out
	}
	byID := func(id *string) func(store.Member) bool {
		return func(m store.Member) bool { return id != nil && m.ID == *id }
	}
	switch cfg.To {
	case "creator":
		return pick(byID(is.CreatedBy), false), "quem criou a issue"
	case "assignee":
		return pick(byID(is.AssigneeID), false), "o responsável"
	case "responsible":
		st, err := e.st.StageOf(ctx, is.WorkspaceID, is.Status)
		if err != nil || st.Policy.Responsible.Empty() {
			return nil, "os responsáveis da etapa"
		}
		return pick(func(m store.Member) bool { u := m.User; return st.Policy.Responsible.Has(&u) }, false), "os responsáveis da etapa"
	case "team":
		out := pick(func(store.Member) bool { return true }, true)
		return out, fmt.Sprintf("o time (%d pessoas)", len(out))
	case "admins":
		out := pick(func(m store.Member) bool { return isAdmin(m.User) }, true)
		return out, fmt.Sprintf("os administradores (%d)", len(out))
	case "roles":
		out := pick(func(m store.Member) bool { return m.RoleID != nil && slices.Contains(cfg.Roles, *m.RoleID) }, true)
		return out, fmt.Sprintf("os perfis escolhidos (%d pessoas)", len(out))
	case "users":
		out := pick(func(m store.Member) bool { return slices.Contains(cfg.Users, m.ID) }, false)
		return out, fmt.Sprintf("%d pessoa(s) escolhida(s)", len(out))
	default: // requester
		return pick(byID(e.requester(ctx, is)), false), "quem pediu"
	}
}

// pickAssignee escolhe o responsável: alguém fixo, quem criou, quem pediu, ou
// "equilibrar" — dentre os perfis/usuários escolhidos, quem tem menos issues abertas.
func (e *Engine) pickAssignee(ctx context.Context, is *store.Issue, cfg Config) (*store.User, error) {
	ms := e.members(ctx, is.WorkspaceID)
	find := func(id *string) (*store.User, error) {
		for _, m := range ms {
			if id != nil && m.ID == *id {
				u := m.User
				return &u, nil
			}
		}
		return nil, errors.New("a pessoa não tem acesso a este workspace")
	}
	switch cfg.Mode {
	case "creator":
		return find(is.CreatedBy)
	case "requester":
		return find(e.requester(ctx, is))
	case "balance":
		load := e.st.OpenLoad(ctx, is.WorkspaceID)
		var best *store.User
		for _, m := range ms {
			if !(slices.Contains(cfg.Users, m.ID) || (m.RoleID != nil && slices.Contains(cfg.Roles, *m.RoleID))) {
				continue
			}
			u := m.User
			if best == nil || load[u.ID] < load[best.ID] {
				best = &u
			}
		}
		if best == nil {
			return nil, errors.New("ninguém dos perfis/usuários escolhidos tem acesso a este workspace")
		}
		return best, nil
	default:
		if len(cfg.Users) == 0 {
			return nil, errors.New("escolha a pessoa")
		}
		return find(&cfg.Users[0])
	}
}

func (e *Engine) lastOutcomeNote(ctx context.Context, issueID string) string {
	runs, err := e.st.ListRuns(ctx, issueID)
	if err != nil || len(runs) == 0 {
		return ""
	}
	last := runs[len(runs)-1]
	return firstNonEmpty(last.OutcomeNote, last.Error)
}

func (e *Engine) webhook(ctx context.Context, cfg Config, payload map[string]any) (string, error) {
	if !strings.HasPrefix(cfg.URL, "http://") && !strings.HasPrefix(cfg.URL, "https://") {
		return "", errors.New("URL do webhook inválida")
	}
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", cfg.URL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Multica")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return "", fmt.Errorf("o webhook respondeu %d", res.StatusCode)
	}
	return fmt.Sprintf("webhook chamado (%d).", res.StatusCode), nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
