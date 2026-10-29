// Package automation runs the workflow rules. Triggers: entering or leaving a stage,
// sitting still in it, issue created, comment, agent started or finished, merge done or
// in conflict, assignee or priority changed, and cost above a value. Each rule may have
// conditions (current stage, priority, labels, agent, outcome, role of whoever caused
// it) and performs one action. No stage has built-in behaviour: even "a request to the
// agent goes to In progress" is a rule of the default workflow (migration 016).
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

	"foreman/internal/notify"
	"foreman/internal/runner"
	"foreman/internal/store"
)

type Engine struct {
	st  *store.Store
	run *runner.Runner
	ntf *notify.Notifier

	mu    sync.Mutex
	moves map[string][]time.Time // issue → recent changes made by rules (anti-loop)
}

func New(st *store.Store, run *runner.Runner, ntf *notify.Notifier) *Engine {
	e := &Engine{st: st, run: run, ntf: ntf, moves: map[string][]time.Time{}}
	st.OnEvent = e.handle
	return e
}

// Start turns on the sweep of time-based triggers (sitting in the stage, cost).
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

// Config of each action (the JSON saved in rules.config).
type Config struct {
	To       string   `json:"to,omitempty"`        // notify: creator|requester|assignee|responsible|team|admins|roles|users; move: etapa
	Roles    []string `json:"roles,omitempty"`     // notify/assign: perfis
	Users    []string `json:"users,omitempty"`     // notify/assign: users
	Message  string   `json:"message,omitempty"`   // notify/webhook/comment
	URL      string   `json:"url,omitempty"`       // webhook
	AgentID  string   `json:"agentId,omitempty"`   // run_agent/set_agent
	Request  string   `json:"request,omitempty"`   // run_agent
	Base     string   `json:"base,omitempty"`      // open_pr/merge
	Draft    bool     `json:"draft,omitempty"`     // open_pr
	Script   string   `json:"script,omitempty"`    // script
	OnFail   string   `json:"onFail,omitempty"`    // stage to send it to if it fails
	Wait     bool     `json:"wait,omitempty"`      // run_agent: wait for it to finish in this stage before the next rules
	OnWait   string   `json:"onWaiting,omitempty"` // run_agent with wait: if the AI needs someone, move to
	Priority *int     `json:"priority,omitempty"`  // set_priority
	LabelID  string   `json:"labelId,omitempty"`   // add_label
	Mode     string   `json:"mode,omitempty"`      // assign: user|creator|requester|balance
}

const maxAutoMoves = 8 // por issue, por minuto

func (e *Engine) handle(ev store.Event) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Hour)
		defer cancel()
		defer func() {
			if p := recover(); p != nil {
				log.Printf("automation: panic in %s: %v", ev.IssueID, p)
			}
		}()
		is, err := e.st.Issue(ctx, ev.IssueID)
		if err != nil {
			return
		}
		switch ev.Kind {
		case "created":
			// Creating in a stage is also entering it.
			e.fire(ctx, is, ev, "created", "")
			if cur, err := e.st.Issue(ctx, is.ID); err == nil && cur.Status == is.Status {
				e.fire(ctx, cur, store.Event{Kind: "stage", IssueID: is.ID, To: is.Status, ActorID: ev.ActorID}, "enter", is.Status)
			}
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

// sweep: time- and limit-based triggers, once per rule and issue.
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
		// On enter: a previous rule may have taken the issue out of the stage.
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

// matches checks the rule's conditions.
func (e *Engine) matches(ctx context.Context, is *store.Issue, c store.Conditions, ev store.Event) bool {
	if len(c.Stages) > 0 && !slices.Contains(c.Stages, is.Status) {
		return false
	}
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
	label := actionLabel(r.Action)
	msg, err := e.apply(ctx, is, ev, r.Action, cfg)
	switch {
	case errors.Is(err, errSkip):
		return false
	case errors.Is(err, errStop):
		return true
	case err != nil:
		e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Rule **%s** (%s) failed: %s", label, e.triggerText(ctx, is, r), err))
		// The rule's own "If it fails, move to" applies first; without it, the "A rule
		// failed" rules decide (the default takes it to Blocked).
		if cfg.OnFail != "" && e.st.ValidStage(ctx, is.WorkspaceID, cfg.OnFail) {
			if cfg.OnFail != is.Status {
				e.move(ctx, is, cfg.OnFail)
			}
		} else if r.Trigger != "rule_failed" {
			e.st.Emit(ctx, store.Event{Kind: "rule_failed", IssueID: is.ID})
		}
		return true
	case msg != "" && !(r.Action == "move" && routine[r.Trigger]):
		// Routing by the agent's or the merge's outcome happens on every run: it doesn't
		// become a comment (the new stage already shows it).
		e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Rule **%s**: %s", label, msg))
	}
	return false
}

func (e *Engine) triggerText(ctx context.Context, is *store.Issue, r store.Rule) string {
	st := e.st.StageName(ctx, is.WorkspaceID, r.Stage)
	return map[string]string{
		"enter": "on entering " + st, "leave": "on leaving " + st, "stale": "sitting in " + st,
		"created": "issue created", "commented": "comment", "run_started": "agent started", "run_finished": "run finished",
		"merged": "merge done", "merge_conflict": "merge conflict", "rule_failed": "a rule failed",
		"cost_over": "cost over the limit", "assigned": "assignee set", "priority_changed": "priority changed",
	}[r.Trigger]
}

var errSkip = errors.New("nothing to do")

// Routine triggers (every run goes through them).
var routine = map[string]bool{"run_started": true, "run_finished": true, "merged": true, "merge_conflict": true}

func actionLabel(a string) string {
	return map[string]string{
		"notify": "Notify", "webhook": "Webhook", "move": "Move", "run_agent": "Run agent",
		"open_pr": "Open PR", "merge": "Merge", "script": "Script", "set_agent": "Set agent",
		"set_priority": "Set priority", "add_label": "Add label", "assign": "Set assignee", "comment": "Comment",
		"stop_agent": "Stop the agent",
	}[a]
}

var priorityName = []string{"No priority", "Urgent", "High", "Medium", "Low"}

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
		if ev.Kind == "run_finished" || ev.Kind == "stage" {
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
		return fmt.Sprintf("e-mail sent to %s.", who), nil

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
			return "", errors.New("too many automatic changes in a row; stopped to avoid a loop")
		}
		return "moved to " + e.st.StageName(ctx, is.WorkspaceID, cfg.To) + ".", nil

	case "run_agent":
		if cfg.AgentID == "" && is.AgentID == nil {
			return "", errSkip // no agent: it stays a manual task
		}
		if is.ActiveRun != nil {
			return "", errSkip // it is already working on it
		}
		kind, request := "followup", strings.TrimSpace(cfg.Request)
		if request == "" {
			kind = "initial"
		}
		// Waiting only makes sense in a stage: the issue stays there until the agent finishes.
		if cfg.Wait && (ev.Kind == "stage" || ev.Kind == "stale") {
			return e.agentStep(ctx, is, cfg, kind, request)
		}
		// A normal request: the "agent started/finished" rules decide the stage.
		if _, err := e.run.Enqueue(ctx, is, cfg.AgentID, kind, request, ev.ActorID); err != nil {
			return "", err
		}
		return "request sent to the agent.", nil

	case "stop_agent":
		run, err := e.st.ActiveRun(ctx, is.ID)
		if err != nil {
			return "", errSkip
		}
		e.run.Cancel(ctx, run.ID)
		return "run stopped.", nil

	case "set_agent":
		if cfg.AgentID == "" || (is.AgentID != nil && *is.AgentID == cfg.AgentID) {
			return "", errSkip
		}
		a, err := e.st.Agent(ctx, cfg.AgentID)
		if err != nil {
			return "", errors.New("agent not found")
		}
		e.patch(ctx, is, map[string]any{"agentId": a.ID})
		return "agent set: " + a.Name + ".", nil

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
			return "", errors.New("label doesn't exist in this workspace")
		}
		labels := []any{}
		for _, id := range append(slices.Clone(is.LabelIDs), l.ID) {
			labels = append(labels, id)
		}
		e.patch(ctx, is, map[string]any{"labelIds": labels})
		return "label " + l.Name + " added.", nil

	case "assign":
		u, err := e.pickAssignee(ctx, is, cfg)
		if err != nil {
			return "", err
		}
		if is.AssigneeID != nil && *is.AssigneeID == u.ID {
			return "", errSkip
		}
		e.patch(ctx, is, map[string]any{"assigneeId": u.ID})
		return "assignee: " + u.Name + ".", nil

	case "comment":
		if strings.TrimSpace(cfg.Message) == "" {
			return "", errSkip
		}
		return strings.TrimSpace(cfg.Message), nil

	case "open_pr":
		urls, err := e.run.OpenPRs(ctx, is, ref, cfg.Base, cfg.Draft)
		if len(urls) == 0 && err != nil && err.Error() == "no repository changed" {
			return "", errSkip
		}
		msg := ""
		if len(urls) > 0 {
			msg = "PR opened — " + strings.Join(urls, "; ")
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
			return "", errSkip // nothing changed or already merged (e.g. a merge done with the button)
		}
		res, err := e.run.Merge(ctx, is, targets, &store.User{Name: "Foreman"})
		if err != nil {
			return "", err
		}
		if res.Conflict {
			return "", errors.New("conflict; nothing was published: use \"Resolve conflict with AI\"")
		}
		var parts []string
		for _, m := range res.Repos {
			parts = append(parts, fmt.Sprintf("%s → %s (%s)", m.Name, m.Target, m.SHA))
		}
		return "merge done: " + strings.Join(parts, ", ") + ".", nil

	case "script":
		if strings.TrimSpace(cfg.Script) == "" {
			return "", errSkip
		}
		out, err := e.run.RunScript(ctx, is.ID, cfg.Script, []string{
			"FOREMAN_ISSUE=" + ref, "FOREMAN_TITLE=" + is.Title, "FOREMAN_BRANCH=" + is.Branch,
			"FOREMAN_STAGE=" + is.Status, "FOREMAN_FROM=" + ev.From, "FOREMAN_EVENT=" + ev.Kind,
			"FOREMAN_README=" + e.run.ReadmePath(is.ID), "FOREMAN_WORKSPACE=" + ws.Key,
			fmt.Sprintf("FOREMAN_PRIORITY=%d", is.Priority),
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
	return "", fmt.Errorf("unknown action %q", action)
}

func (e *Engine) headline(ref, stage string, is *store.Issue, ev store.Event) string {
	switch ev.Kind {
	case "created":
		return fmt.Sprintf("New issue %s (%s)", ref, priorityName[min(max(int(is.Priority), 0), 4)])
	case "commented":
		return fmt.Sprintf("New comment on %s", ref)
	case "run_finished":
		return fmt.Sprintf("The agent finished %s: %s", ref, map[string]string{
			"done": "done", "waiting": "waiting for you", "incomplete": "incomplete", "failed": "failed", "cancelled": "cancelled"}[ev.Outcome])
	case "run_started":
		return fmt.Sprintf("The agent started %s", ref)
	case "merged":
		return fmt.Sprintf("Merge done on %s", ref)
	case "merge_conflict":
		return fmt.Sprintf("Merge conflict on %s", ref)
	case "stale":
		return fmt.Sprintf("%s is sitting in %s", ref, stage)
	case "cost_over":
		return fmt.Sprintf("%s went over the cost limit", ref)
	case "assigned":
		return fmt.Sprintf("You are the assignee of %s", ref)
	case "priority_changed":
		return fmt.Sprintf("%s is now %s", ref, priorityName[min(max(int(is.Priority), 0), 4)])
	}
	if ev.Kind == "stage" && ev.From == is.Status {
		return fmt.Sprintf("%s left %s", ref, stage)
	}
	return fmt.Sprintf("%s entered %s", ref, stage)
}

// errStop ends the stage's sequence without treating it as the rule's failure.
var errStop = errors.New("sequence ended")

// agentStep: a stage step that runs the agent and WAITS for it to finish. The issue stays
// in the stage meanwhile. Done → on to the next rule; waiting or incomplete → stops the
// sequence (and goes to "if it needs someone", if chosen); failure → the rule's error
// (goes to "if it fails", if chosen).
func (e *Engine) agentStep(ctx context.Context, is *store.Issue, cfg Config, kind, request string) (string, error) {
	run, err := e.run.EnqueueInStage(ctx, is, cfg.AgentID, kind, request)
	if err != nil {
		return "", err
	}
	e.run.SystemComment(ctx, is, fmt.Sprintf("⚙ Stage step: %s is working; the next rules run when it finishes.", run.AgentName))
	deadline := time.Now().Add(3 * time.Hour)
	for {
		select {
		case <-ctx.Done():
			return "", errors.New("the agent went over the step's time limit")
		case <-time.After(2 * time.Second):
		}
		cur, err := e.st.Run(ctx, run.ID)
		if err != nil {
			return "", err
		}
		switch cur.Status {
		case "queued", "running":
			if time.Now().After(deadline) {
				return "", errors.New("the agent went over 3 hours")
			}
			continue
		case "cancelled":
			return "", errStop
		case "failed":
			return "", fmt.Errorf("the agent failed: %s", firstNonEmpty(cur.Error, "no details"))
		}
		if cur.Outcome == "waiting" || cur.Outcome == "incomplete" {
			if cfg.OnWait != "" && e.st.ValidStage(ctx, is.WorkspaceID, cfg.OnWait) {
				e.move(ctx, is, cfg.OnWait)
			}
			return "", errStop
		}
		note := ""
		if cur.OutcomeNote != "" {
			note = ": " + cur.OutcomeNote
		}
		return fmt.Sprintf("%s terminou%s.", cur.AgentName, note), nil
	}
}

// patch changes the issue's fields the way Foreman does (it fires each field's events).
func (e *Engine) patch(ctx context.Context, is *store.Issue, fields map[string]any) {
	if updated, err := e.st.PatchIssue(ctx, is.ID, fields); err == nil {
		*is = *updated
		e.run.PublishIssue(ctx, is.ID)
	}
}

// move changes the stage by rule, with a limit against loops (A→B→A…).
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
	e.st.SetIssueStatus(ctx, is.ID, to)
	e.run.PublishIssue(ctx, is.ID)
	return true
}

// ---------- pessoas ----------

// members: who has access to the workspace (only they get e-mail or become assignees).
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

// recipients resolves the target group into e-mails of whoever has access to the workspace.
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
		return pick(byID(is.CreatedBy), false), "whoever created the issue"
	case "assignee":
		return pick(byID(is.AssigneeID), false), "the assignee"
	case "responsible":
		st, err := e.st.StageOf(ctx, is.WorkspaceID, is.Status)
		if err != nil || st.Policy.Responsible.Empty() {
			return nil, "the stage's owners"
		}
		return pick(func(m store.Member) bool { u := m.User; return st.Policy.Responsible.Has(&u) }, false), "the stage's owners"
	case "team":
		out := pick(func(store.Member) bool { return true }, true)
		return out, fmt.Sprintf("the team (%d people)", len(out))
	case "admins":
		out := pick(func(m store.Member) bool { return isAdmin(m.User) }, true)
		return out, fmt.Sprintf("the admins (%d)", len(out))
	case "roles":
		out := pick(func(m store.Member) bool { return m.RoleID != nil && slices.Contains(cfg.Roles, *m.RoleID) }, true)
		return out, fmt.Sprintf("the chosen roles (%d people)", len(out))
	case "users":
		out := pick(func(m store.Member) bool { return slices.Contains(cfg.Users, m.ID) }, false)
		return out, fmt.Sprintf("%d chosen person(s)", len(out))
	default: // requester
		return pick(byID(e.requester(ctx, is)), false), "whoever asked"
	}
}

// pickAssignee picks the assignee: someone fixed, whoever created, whoever asked, or
// "balance" — among the chosen roles/users, whoever has the fewest open issues.
func (e *Engine) pickAssignee(ctx context.Context, is *store.Issue, cfg Config) (*store.User, error) {
	ms := e.members(ctx, is.WorkspaceID)
	find := func(id *string) (*store.User, error) {
		for _, m := range ms {
			if id != nil && m.ID == *id {
				u := m.User
				return &u, nil
			}
		}
		return nil, errors.New("that person doesn't have access to this workspace")
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
			return nil, errors.New("none of the chosen roles/users has access to this workspace")
		}
		return best, nil
	default:
		if len(cfg.Users) == 0 {
			return nil, errors.New("choose the person")
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
		return "", errors.New("invalid webhook URL")
	}
	body, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", cfg.URL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Foreman")
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
