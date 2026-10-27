// Package automation roda as regras do fluxo: quando uma issue entra numa
// etapa, as regras daquela etapa disparam na ordem (notificar, webhook, mover,
// rodar agente, abrir PR, merge, script). Cada ação deixa um comentário de
// sistema na issue, para ficar registrado o que aconteceu.
package automation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
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
	st.OnStatusChange = e.changed
	return e
}

// Config de cada ação (o JSON salvo em rules.config).
type Config struct {
	To      string `json:"to,omitempty"`      // notify: requester | author | workspace | emails; move: etapa de destino
	Emails  string `json:"emails,omitempty"`  // notify: lista separada por vírgula
	Message string `json:"message,omitempty"` // notify/webhook: texto extra
	URL     string `json:"url,omitempty"`     // webhook
	AgentID string `json:"agentId,omitempty"` // run_agent (vazio = agente da issue)
	Request string `json:"request,omitempty"` // run_agent: o que pedir
	Base    string `json:"base,omitempty"`    // open_pr / merge: branch de destino (vazio = a da issue)
	Draft   bool   `json:"draft,omitempty"`   // open_pr
	Script  string `json:"script,omitempty"`  // script
	OnFail  string `json:"onFail,omitempty"`  // script/merge/open_pr: etapa para onde mandar se falhar
}

const maxAutoMoves = 8 // por issue, por minuto

func (e *Engine) changed(c store.StatusChange) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		defer cancel()
		defer func() {
			if p := recover(); p != nil {
				log.Printf("automação: pânico em %s: %v", c.IssueID, p)
			}
		}()
		e.fire(ctx, c)
	}()
}

func (e *Engine) fire(ctx context.Context, c store.StatusChange) {
	is, err := e.st.Issue(ctx, c.IssueID)
	if err != nil || is.Status != c.To {
		return // a issue já saiu da etapa (ex.: outra regra moveu)
	}
	rules, err := e.st.RulesFor(ctx, is.WorkspaceID, c.To)
	if err != nil || len(rules) == 0 {
		return
	}
	for _, r := range rules {
		var cfg Config
		json.Unmarshal(r.Config, &cfg)
		// Uma regra anterior pode ter tirado a issue desta etapa.
		if cur, err := e.st.Issue(ctx, is.ID); err != nil || cur.Status != c.To {
			return
		} else {
			is = cur
		}
		msg, err := e.apply(ctx, is, c, r.Action, cfg)
		label := actionLabel(r.Action)
		switch {
		case errors.Is(err, errSkip):
			continue
		case err != nil:
			e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Regra **%s** (%s) falhou: %s", label, e.st.StageName(ctx, is.WorkspaceID, c.To), err))
			if cfg.OnFail != "" && cfg.OnFail != c.To && e.st.ValidStage(ctx, is.WorkspaceID, cfg.OnFail) {
				e.move(ctx, is, cfg.OnFail)
			}
			return
		case msg != "":
			e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Regra **%s**: %s", label, msg))
		}
	}
}

var errSkip = errors.New("nada a fazer")

func actionLabel(a string) string {
	return map[string]string{
		"notify": "Notificar", "webhook": "Webhook", "move": "Mover", "run_agent": "Rodar agente",
		"open_pr": "Abrir PR", "merge": "Merge", "script": "Script",
	}[a]
}

func (e *Engine) apply(ctx context.Context, is *store.Issue, c store.StatusChange, action string, cfg Config) (string, error) {
	ws, err := e.st.Workspace(ctx, is.WorkspaceID)
	if err != nil {
		return "", err
	}
	ref := fmt.Sprintf("%s-%d", ws.Key, is.Number)
	stage := e.st.StageName(ctx, is.WorkspaceID, c.To)

	switch action {
	case "notify":
		to, who := e.recipients(ctx, is, cfg)
		headline := fmt.Sprintf("%s entrou em %s", ref, stage)
		if c.To == "waiting" {
			headline = fmt.Sprintf("%s precisa de você", ref)
		}
		note := strings.TrimSpace(cfg.Message)
		if c.To == "waiting" || c.To == "blocked" {
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
		return e.webhook(ctx, cfg, map[string]any{
			"event": "issue.stage", "workspace": ws.Name, "ref": ref, "title": is.Title,
			"from": c.From, "to": c.To, "stage": stage, "branch": is.Branch, "message": cfg.Message,
			// Slack/Discord/Teams aceitam texto simples nestes campos.
			"text":    fmt.Sprintf("%s · %s → %s", ref, is.Title, stage),
			"content": fmt.Sprintf("%s · %s → %s", ref, is.Title, stage),
		})

	case "move":
		if cfg.To == "" || cfg.To == c.To || !e.st.ValidStage(ctx, is.WorkspaceID, cfg.To) {
			return "", errors.New("etapa de destino inválida")
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
		if _, err := e.run.Enqueue(ctx, is, cfg.AgentID, kind, request, nil); err != nil {
			return "", err
		}
		return "pedido enviado ao agente.", nil

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
			"MULTICA_STAGE=" + c.To, "MULTICA_FROM=" + c.From, "MULTICA_README=" + e.run.ReadmePath(is.ID),
			"MULTICA_WORKSPACE=" + ws.Key,
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

func (e *Engine) recipients(ctx context.Context, is *store.Issue, cfg Config) ([]string, string) {
	userEmail := func(id *string) []string {
		if id == nil {
			return nil
		}
		if u, err := e.st.UserByID(ctx, *id); err == nil {
			return []string{u.Email}
		}
		return nil
	}
	switch cfg.To {
	case "author":
		return userEmail(is.CreatedBy), "quem criou a issue"
	case "workspace":
		rs, _ := e.st.NotificationRecipients(ctx, is.WorkspaceID, "")
		var out []string
		for _, r := range rs {
			out = append(out, r.Email)
		}
		return out, fmt.Sprintf("o workspace (%d pessoas)", len(out))
	case "emails":
		var out []string
		for _, s := range strings.FieldsFunc(cfg.Emails, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' }) {
			if strings.Contains(s, "@") {
				out = append(out, s)
			}
		}
		return out, strings.Join(out, ", ")
	default: // requester: quem fez o último pedido (ou quem criou)
		var by *string
		if runs, err := e.st.ListRuns(ctx, is.ID); err == nil {
			for i := len(runs) - 1; i >= 0; i-- {
				if runs[i].CreatedBy != nil {
					by = runs[i].CreatedBy
					break
				}
			}
		}
		if by == nil {
			by = is.CreatedBy
		}
		return userEmail(by), "quem pediu"
	}
}

func (e *Engine) lastOutcomeNote(ctx context.Context, issueID string) string {
	runs, err := e.st.ListRuns(ctx, issueID)
	if err != nil || len(runs) == 0 {
		return ""
	}
	last := runs[len(runs)-1]
	if last.OutcomeNote != "" {
		return last.OutcomeNote
	}
	return last.Error
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
