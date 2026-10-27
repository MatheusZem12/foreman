package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"multica/internal/store"
)

// ---------- etapas ----------

func (a *API) listStages(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.Stages(r.Context(), chi.URLParam(r, "ws"))
}

type stageInput struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	After string `json:"after"` // etapa depois da qual a nova entra
}

// positionAfter devolve uma posição entre a etapa "after" e a seguinte.
func positionAfter(stages []store.Stage, after, self string) float64 {
	for i, s := range stages {
		if s.ID != after {
			continue
		}
		for j := i + 1; j < len(stages); j++ {
			if stages[j].ID != self {
				return (s.Position + stages[j].Position) / 2
			}
		}
		return s.Position + 10
	}
	return stages[len(stages)-1].Position + 10
}

func (a *API) saveStage(w http.ResponseWriter, r *http.Request) (any, error) {
	var in stageInput
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, bad("dê um nome à etapa")
	}
	if in.Color == "" {
		in.Color = "#a78bfa"
	}
	st := store.Stage{Name: in.Name, Color: in.Color}
	if id := chi.URLParam(r, "id"); id != "" {
		cur, err := a.st.Stage(r.Context(), id)
		if err != nil {
			return nil, err
		}
		if err := a.ensureAccess(r, cur.WorkspaceID); err != nil {
			return nil, err
		}
		st.ID, st.WorkspaceID, st.Position = cur.ID, cur.WorkspaceID, cur.Position
	} else {
		st.WorkspaceID = chi.URLParam(r, "ws")
	}
	all, err := a.st.Stages(r.Context(), st.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if in.After != "" || st.ID == "" {
		st.Position = positionAfter(all, firstNonEmptyStr(in.After, "in_review"), st.ID)
	}
	return a.st.SaveStage(r.Context(), st)
}

func (a *API) deleteStage(w http.ResponseWriter, r *http.Request) (any, error) {
	st, err := a.st.Stage(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, st.WorkspaceID); err != nil {
		return nil, err
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
	if !store.RuleActions[in.Action] {
		return nil, bad("ação desconhecida")
	}
	if !a.st.ValidStage(ctx, in.WorkspaceID, in.Stage) {
		return nil, bad("etapa inválida")
	}
	var cfg map[string]any
	if len(in.Config) > 0 && json.Unmarshal(in.Config, &cfg) != nil {
		return nil, bad("configuração inválida")
	}
	str := func(k string) string { s, _ := cfg[k].(string); return strings.TrimSpace(s) }
	switch in.Action {
	case "move":
		if to := str("to"); to == "" || to == in.Stage || !a.st.ValidStage(ctx, in.WorkspaceID, to) {
			return nil, bad("escolha a etapa de destino (diferente desta)")
		}
	case "webhook":
		if u := str("url"); !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			return nil, bad("informe a URL do webhook (http/https)")
		}
	case "script":
		if str("script") == "" {
			return nil, bad("escreva o script")
		}
	case "notify":
		if str("to") == "emails" && !strings.Contains(str("emails"), "@") {
			return nil, bad("informe ao menos um e-mail")
		}
	}
	if f := str("onFail"); f != "" && !a.st.ValidStage(ctx, in.WorkspaceID, f) {
		return nil, bad("etapa de falha inválida")
	}
	return a.st.SaveRule(ctx, in)
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

// ---------- aprovar ----------

// approveIssue: o "OK" da revisão. Só vale em "Em revisão"; leva para
// Concluída, onde as regras da etapa (por padrão, o merge) disparam.
func (a *API) approveIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	if is.Status != "in_review" {
		return nil, bad("só dá para aprovar uma issue em revisão")
	}
	u := userOf(r)
	if err := a.st.SetIssueStatus(store.WithActor(r.Context(), u.ID), is.ID, "done"); err != nil {
		return nil, err
	}
	is, _ = a.st.Issue(r.Context(), is.ID)
	a.publishIssue(is)
	return is, nil
}
