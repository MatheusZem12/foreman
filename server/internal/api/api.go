// Package api expõe a API JSON usada pelo front-end.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"golang.org/x/crypto/bcrypt"

	"multica/internal/config"
	"multica/internal/hub"
	"multica/internal/notify"
	"multica/internal/runner"
	"multica/internal/store"
)

const sessionCookie = "mx_session"
const sessionTTL = 30 * 24 * time.Hour

type API struct {
	cfg config.Config
	st  *store.Store
	hub *hub.Hub
	run *runner.Runner
	ntf *notify.Notifier
}

type ctxKey struct{}

// httpError carrega o status HTTP junto com a mensagem mostrada ao usuário.
type httpError struct {
	status int
	msg    string
	format string // para traduzir (i18n.go): o formato e os argumentos
	args   []any
}

func (e httpError) Error() string { return e.msg }

func bad(format string, a ...any) error {
	return httpError{http.StatusBadRequest, fmt.Sprintf(format, a...), format, a}
}

func Router(cfg config.Config, st *store.Store, h *hub.Hub, rn *runner.Runner, ntf *notify.Notifier, static http.Handler) http.Handler {
	a := &API{cfg: cfg, st: st, hub: h, run: rn, ntf: ntf}
	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer, withLang)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
		r.Get("/setup", a.h(a.getSetup))
		r.Post("/setup", a.h(a.postSetup))
		r.Post("/login", a.h(a.login))
		r.Post("/logout", a.h(a.logout))
		// Entrada de issues por webhook: sem login, o token do endereço é a credencial.

		r.Group(func(r chi.Router) {
			r.Use(a.auth)
			r.Get("/me", a.h(a.me))
			r.Patch("/me", a.h(a.patchMe))
			r.Get("/me/prefs/{key}", a.h(a.getPref))
			r.Put("/me/prefs/{key}", a.h(a.putPref))
			// Usuários: todos leem (nomes nos comentários); gerenciar depende do perfil.
			r.Get("/users", a.h(a.listUsers))
			r.With(a.can("user.view", "user.create", "user.update", "user.delete")).Get("/users/{id}/profile", a.h(a.userProfile))
			r.With(a.can("user.create")).Post("/users", a.h(a.createUser))
			r.With(a.can("user.update")).Patch("/users/{id}", a.h(a.patchUser))
			r.With(a.can("user.delete")).Delete("/users/{id}", a.h(a.deleteUser))

			// Perfis de acesso: só o dono define; quem gerencia usuários lê para atribuir.
			r.Get("/permissions", a.h(a.listPermissions))
			r.With(a.can("user.create", "user.update")).Get("/roles", a.h(a.listRoles))
			r.With(a.owner).Post("/roles", a.h(a.saveRole))
			r.With(a.owner).Put("/roles/{id}", a.h(a.saveRole))
			r.With(a.owner).Delete("/roles/{id}", a.h(a.deleteRole))

			// Workspaces: cada um vê os seus.
			r.Get("/workspaces", a.h(a.listWorkspaces))
			r.With(a.can("workspace.create")).Post("/workspaces", a.h(a.createWorkspace))
			r.Route("/workspaces/{ws}", func(r chi.Router) {
				r.Use(a.member)
				r.With(a.can("workspace.update")).Patch("/", a.h(a.patchWorkspace))
				r.With(a.can("workspace.delete")).Delete("/", a.h(a.deleteWorkspace))
				r.Get("/members", a.h(a.listMembers))
				r.With(a.can("member.manage")).Put("/members/{user}", a.h(a.addMember))
				r.With(a.can("member.manage")).Delete("/members/{user}", a.h(a.removeMember))
				r.Get("/repos", a.h(a.listRepos))
				r.With(a.can("repo.create")).Post("/repos", a.h(a.saveRepo))
				r.Get("/labels", a.h(a.listLabels))
				r.With(a.can("label.create")).Post("/labels", a.h(a.createLabel))
				r.Get("/issues", a.h(a.listIssues))
				r.Get("/board", a.h(a.board))
				r.Get("/working", a.h(a.working))
				r.With(a.can("analytics.view")).Get("/analytics", a.h(a.workspaceAnalytics))
				r.With(a.can("issue.create")).Post("/issues", a.h(a.createIssue))
				r.Get("/events", a.events)
				r.Get("/stages", a.h(a.listStages))
				r.With(a.can("workflow.manage")).Post("/stages", a.h(a.saveStage))
				r.With(a.can("workflow.manage")).Put("/stages/order", a.h(a.orderStages))
				r.With(a.can("workflow.manage")).Put("/stages/{id}", a.h(a.saveStage))
				r.With(a.can("workflow.manage")).Delete("/stages/{id}", a.h(a.deleteStage))
				r.Get("/rules", a.h(a.listRules))
				r.With(a.can("workflow.manage")).Post("/rules", a.h(a.saveRule))
				r.With(a.can("workflow.manage")).Put("/rules/order", a.h(a.orderRules))
				r.With(a.can("workflow.view", "workflow.manage")).Get("/workflow/warnings", a.h(a.getWarnings))
				r.With(a.can("workflow.duplicate")).Post("/workflow/copy", a.h(a.copyWorkflow))
			})
			r.With(a.can("workflow.manage")).Put("/rules/{id}", a.h(a.saveRule))
			r.With(a.can("workflow.manage")).Delete("/rules/{id}", a.h(a.deleteRule))
			r.With(a.can("repo.update")).Put("/repos/{id}", a.h(a.saveRepo))
			r.With(a.can("repo.delete")).Delete("/repos/{id}", a.h(a.deleteRepo))
			r.Get("/repos/{id}/branches", a.h(a.repoBranches))
			r.With(a.can("label.update")).Put("/labels/{id}", a.h(a.updateLabel))
			r.With(a.can("label.delete")).Delete("/labels/{id}", a.h(a.deleteLabel))
			r.With(a.can("repo.create", "repo.update", "settings.manage")).Get("/git", a.h(a.gitInfo))

			// Agentes e skills são globais: todos usam, o perfil define quem edita.
			r.Get("/agents", a.h(a.listAgents))
			r.With(a.can("agent.create")).Post("/agents", a.h(a.saveAgent))
			r.With(a.can("agent.update")).Put("/agents/{id}", a.h(a.saveAgent))
			r.With(a.can("agent.delete")).Delete("/agents/{id}", a.h(a.deleteAgent))
			r.Get("/skills", a.h(a.listSkills))
			r.With(a.can("skill.create")).Post("/skills", a.h(a.saveSkill))
			r.With(a.can("skill.update")).Put("/skills/{id}", a.h(a.saveSkill))
			r.With(a.can("skill.update")).Put("/skills/{id}/agents", a.h(a.skillAgents))
			r.With(a.can("skill.delete")).Delete("/skills/{id}", a.h(a.deleteSkill))

			r.Get("/issues/{id}", a.h(a.getIssue))
			// Issues: a permissão de cada campo e a política da etapa são conferidas no handler.
			r.Patch("/issues/{id}", a.h(a.patchIssue))
			r.Post("/issues/{id}/approve", a.h(a.approveIssue))
			r.Put("/issues/{id}/repos", a.h(a.setIssueRepos))
			r.With(a.can("issue.delete")).Delete("/issues/{id}", a.h(a.deleteIssue))
			r.With(a.can("issue.run")).Post("/issues/{id}/run", a.h(a.runIssue))
			r.With(a.can("issue.run")).Post("/issues/{id}/cancel", a.h(a.cancelIssue))
			r.With(a.can("issue.merge")).Post("/issues/{id}/merge", a.h(a.mergeIssue))
			r.With(a.can("issue.merge")).Post("/issues/{id}/discard", a.h(a.discardIssue))
			r.Get("/issues/{id}/diff", a.h(a.issueDiff))
			r.Post("/issues/{id}/comments", a.h(a.addComment))
			r.Get("/runs/{id}/events", a.h(a.runEvents))

			// E-mail: quem tem settings.manage configura; os demais só sabem se está ligado.
			r.Get("/settings/email", a.h(a.getEmailSettings))
			r.With(a.can("settings.manage")).Put("/settings/email", a.h(a.saveEmailSettings))
			r.With(a.can("settings.manage")).Post("/settings/email/test", a.h(a.testEmailSettings))

			r.With(a.can("analytics.global")).Get("/analytics", a.h(a.globalAnalytics))
			r.Get("/runtimes", a.h(a.runtimes))
			r.Get("/runtimes/models", a.h(a.runtimeModels))
		})
	})
	r.Handle("/*", static)
	return r
}

// ---------- infraestrutura ----------

type handler func(w http.ResponseWriter, r *http.Request) (any, error)

func (a *API) h(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := fn(w, r)
		if err != nil {
			status, msg := http.StatusInternalServerError, err.Error()
			var he httpError
			switch {
			case errors.As(err, &he):
				status = he.status
				if he.format != "" {
					msg = tr(r.Context(), he.format, he.args...)
				}
			case errors.Is(err, store.ErrNotFound):
				status, msg = http.StatusNotFound, "não encontrado"
			case errors.Is(err, runner.ErrBusy):
				status = http.StatusConflict
			case strings.Contains(msg, "duplicate key"):
				status, msg = http.StatusConflict, "já existe um registro com esse nome/chave"
			default:
				log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
			}
			if he.format == "" {
				msg = tr(r.Context(), msg)
			}
			writeJSON(w, status, map[string]string{"error": msg})
			return
		}
		if v == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 8<<20)).Decode(v); err != nil {
		return bad("JSON inválido: %v", err)
	}
	return nil
}

func userOf(r *http.Request) *store.User { return r.Context().Value(ctxKey{}).(*store.User) }

func (a *API) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "faça login"})
			return
		}
		u, err := a.st.UserBySession(r.Context(), c.Value)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sessão expirada"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

// can libera a rota para quem tem qualquer uma das permissões.
func (a *API) can(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u := userOf(r)
			for _, p := range perms {
				if u.Can(p) {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeJSON(w, http.StatusForbidden, map[string]string{"error": tr(r.Context(), "seu perfil não tem permissão para isso")})
		})
	}
}

// owner: só o dono (primeiro cadastro) passa.
func (a *API) owner(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !userOf(r).IsOwner {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": tr(r.Context(), "só o dono do Multica define perfis")})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// member garante que o usuário pode ver o workspace da rota. Para quem não
// pode, responde 404 (não revela que o workspace existe).
func (a *API) member(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.st.CanAccess(r.Context(), userOf(r), chi.URLParam(r, "ws")) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "não encontrado"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) ensureAccess(r *http.Request, wsID string) error {
	if !a.st.CanAccess(r.Context(), userOf(r), wsID) {
		return store.ErrNotFound
	}
	return nil
}

func (a *API) startSession(w http.ResponseWriter, r *http.Request, u *store.User) error {
	buf := make([]byte, 32)
	rand.Read(buf)
	token := hex.EncodeToString(buf)
	if err := a.st.CreateSession(r.Context(), token, u.ID, sessionTTL); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true,
		Secure: a.cfg.SecureCookie, SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
	return nil
}

// ---------- autenticação ----------

func (a *API) getSetup(w http.ResponseWriter, r *http.Request) (any, error) {
	n, err := a.st.CountUsers(r.Context())
	return map[string]bool{"needsSetup": n == 0}, err
}

type credentials struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (c credentials) validate() error {
	if !strings.Contains(c.Email, "@") {
		return bad("e-mail inválido")
	}
	if len(c.Password) < 8 {
		return bad("a senha precisa de pelo menos 8 caracteres")
	}
	if strings.TrimSpace(c.Name) == "" {
		return bad("informe o nome")
	}
	return nil
}

// O primeiro acesso cria o dono (pode tudo e define os perfis); depois disso
// o cadastro é só por quem tem user.create.
func (a *API) postSetup(w http.ResponseWriter, r *http.Request) (any, error) {
	if n, _ := a.st.CountUsers(r.Context()); n > 0 {
		return nil, httpError{status: http.StatusForbidden, msg: "o Multica já foi configurado"}
	}
	var c credentials
	if err := decode(r, &c); err != nil {
		return nil, err
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	var roleID *string
	if role, err := a.st.RoleByName(r.Context(), "Administrador"); err == nil {
		roleID = &role.ID
	}
	u, err := a.st.CreateUser(r.Context(), c.Email, strings.TrimSpace(c.Name), string(hash), true, roleID)
	if err != nil {
		return nil, err
	}
	return u, a.startSession(w, r, u)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) (any, error) {
	var c credentials
	if err := decode(r, &c); err != nil {
		return nil, err
	}
	u, err := a.st.UserByEmail(r.Context(), strings.TrimSpace(c.Email))
	if err != nil || bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(c.Password)) != nil {
		time.Sleep(400 * time.Millisecond)
		return nil, httpError{status: http.StatusUnauthorized, msg: "e-mail ou senha incorretos"}
	}
	return u, a.startSession(w, r, u)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) (any, error) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.st.DeleteSession(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	return nil, nil
}

func (a *API) me(w http.ResponseWriter, r *http.Request) (any, error) { return userOf(r), nil }

func (a *API) patchMe(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		Name     string `json:"name"`
		About    string `json:"about"`
		Password string `json:"password"`
		// Opcional: liga/desliga o e-mail de issue nova para si mesmo.
		EmailNotifications *bool `json:"emailNotifications"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	u := userOf(r)
	if in.EmailNotifications != nil {
		if err := a.st.SetEmailNotifications(r.Context(), u.ID, *in.EmailNotifications); err != nil {
			return nil, err
		}
	}
	if in.Password != "" {
		if len(in.Password) < 8 {
			return nil, bad("a senha precisa de pelo menos 8 caracteres")
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if err := a.st.SetPassword(r.Context(), u.ID, string(hash)); err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(in.Name) == "" {
		in.Name = u.Name
	}
	return a.st.UpdateUser(r.Context(), u.ID, strings.TrimSpace(in.Name), in.About)
}

// Preferências de visualização da própria pessoa, guardadas como JSON opaco.
// A chave é livre (ex.: "board:<workspace>"); o servidor só limita o tamanho.
func (a *API) getPref(w http.ResponseWriter, r *http.Request) (any, error) {
	raw, err := a.st.UserPref(r.Context(), userOf(r).ID, chi.URLParam(r, "key"))
	if err != nil || raw == nil {
		return map[string]any{}, err
	}
	return raw, nil
}

func (a *API) putPref(w http.ResponseWriter, r *http.Request) (any, error) {
	key := chi.URLParam(r, "key")
	if key == "" || len(key) > 100 {
		return nil, bad("chave inválida")
	}
	var v json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 16<<10)).Decode(&v); err != nil || len(v) == 0 || v[0] != '{' {
		return nil, bad("a preferência precisa ser um objeto JSON de até 16 KB")
	}
	if err := a.st.SetUserPref(r.Context(), userOf(r).ID, key, v); err != nil {
		return nil, err
	}
	return v, nil
}

func (a *API) listUsers(w http.ResponseWriter, r *http.Request) (any, error) {
	if u := userOf(r); u.Can("user.update") || u.Can("member.manage") || u.Can("user.view") {
		return a.st.ListUsersWithWorkspaces(r.Context())
	}
	return a.st.ListUsers(r.Context())
}

func (a *API) createUser(w http.ResponseWriter, r *http.Request) (any, error) {
	var c struct {
		credentials
		RoleID       string   `json:"roleId"`
		WorkspaceIDs []string `json:"workspaceIds"`
	}
	if err := decode(r, &c); err != nil {
		return nil, err
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	roleID, err := a.roleOrDefault(r.Context(), c.RoleID)
	if err != nil {
		return nil, err
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(c.Password), bcrypt.DefaultCost)
	u, err := a.st.CreateUser(r.Context(), c.Email, strings.TrimSpace(c.Name), string(hash), false, roleID)
	if err != nil {
		return nil, err
	}
	return u, a.st.SetUserWorkspaces(r.Context(), u.ID, c.WorkspaceIDs)
}

// patchUser: edita nome, perfil, senha e os workspaces de alguém. O dono só
// é editado por ele mesmo, e o perfil dele não muda (ele sempre pode tudo).
func (a *API) patchUser(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	me := userOf(r)
	target, err := a.st.UserByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if target.IsOwner && !me.IsOwner {
		return nil, httpError{status: http.StatusForbidden, msg: "só o próprio dono altera a conta dele"}
	}
	var in struct {
		Name         *string   `json:"name"`
		RoleID       *string   `json:"roleId"`
		Password     string    `json:"password"`
		WorkspaceIDs *[]string `json:"workspaceIds"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
		if _, err := a.st.UpdateUser(ctx, id, strings.TrimSpace(*in.Name), target.About); err != nil {
			return nil, err
		}
	}
	if in.RoleID != nil && !target.IsOwner {
		roleID, err := a.roleOrDefault(ctx, *in.RoleID)
		if err != nil {
			return nil, err
		}
		if err := a.st.SetUserRole(ctx, id, roleID); err != nil {
			return nil, err
		}
	}
	if in.Password != "" {
		if len(in.Password) < 8 {
			return nil, bad("a senha precisa de pelo menos 8 caracteres")
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		if err := a.st.SetPassword(ctx, id, string(hash)); err != nil {
			return nil, err
		}
		if id != me.ID {
			a.st.DeleteUserSessions(ctx, id) // senha redefinida: derruba as sessões abertas
		}
	}
	if in.WorkspaceIDs != nil {
		if err := a.st.SetUserWorkspaces(ctx, id, *in.WorkspaceIDs); err != nil {
			return nil, err
		}
	}
	return a.st.UserByID(ctx, id)
}

// roleOrDefault valida o perfil escolhido; vazio = "Membro".
func (a *API) roleOrDefault(ctx context.Context, id string) (*string, error) {
	if id == "" {
		role, err := a.st.RoleByName(ctx, "Membro")
		if err != nil {
			return nil, nil
		}
		return &role.ID, nil
	}
	role, err := a.st.Role(ctx, id)
	if err != nil {
		return nil, bad("perfil inválido")
	}
	return &role.ID, nil
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) (any, error) {
	id := chi.URLParam(r, "id")
	if id == userOf(r).ID {
		return nil, bad("você não pode remover a si mesmo")
	}
	if t, err := a.st.UserByID(r.Context(), id); err == nil && t.IsOwner {
		return nil, bad("o dono do Multica não pode ser removido")
	}
	return nil, a.st.DeleteUser(r.Context(), id)
}

// ---------- perfis de acesso ----------

func (a *API) listPermissions(w http.ResponseWriter, r *http.Request) (any, error) {
	out := make([]store.Permission, len(store.Permissions))
	for i, p := range store.Permissions {
		out[i] = store.Permission{ID: p.ID, Group: tr(r.Context(), p.Group), Label: tr(r.Context(), p.Label)}
	}
	return out, nil
}

func (a *API) listRoles(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListRoles(r.Context())
}

func (a *API) saveRole(w http.ResponseWriter, r *http.Request) (any, error) {
	var in store.Role
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.ID = chi.URLParam(r, "id")
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, bad("dê um nome ao perfil")
	}
	perms := []string{}
	for _, p := range in.Permissions {
		if !store.ValidPermission(p) {
			return nil, bad("permissão desconhecida: %s", p)
		}
		perms = append(perms, p)
	}
	in.Permissions = perms
	role, err := a.st.SaveRole(r.Context(), in)
	if err != nil && strings.Contains(err.Error(), "duplicate") {
		return nil, bad("já existe um perfil com esse nome")
	}
	return role, err
}

func (a *API) deleteRole(w http.ResponseWriter, r *http.Request) (any, error) {
	role, err := a.st.Role(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if role.Users > 0 {
		return nil, bad("%d usuário(s) usam este perfil; troque o perfil deles antes", role.Users)
	}
	return nil, a.st.DeleteRole(r.Context(), role.ID)
}

// ---------- workspaces, repositórios, labels ----------

var keyRe = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

func (a *API) listWorkspaces(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListWorkspacesFor(r.Context(), userOf(r))
}

func (a *API) listMembers(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListMembers(r.Context(), chi.URLParam(r, "ws"))
}

func (a *API) addMember(w http.ResponseWriter, r *http.Request) (any, error) {
	if _, err := a.st.UserByID(r.Context(), chi.URLParam(r, "user")); err != nil {
		return nil, err
	}
	return nil, a.st.AddMember(r.Context(), chi.URLParam(r, "ws"), chi.URLParam(r, "user"))
}

func (a *API) removeMember(w http.ResponseWriter, r *http.Request) (any, error) {
	return nil, a.st.RemoveMember(r.Context(), chi.URLParam(r, "ws"), chi.URLParam(r, "user"))
}

func (a *API) createWorkspace(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct{ Name, Key string }
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.Key = strings.ToUpper(strings.TrimSpace(in.Key))
	if strings.TrimSpace(in.Name) == "" || !keyRe.MatchString(in.Key) {
		return nil, bad("informe o nome e uma chave de 2 a 10 letras/números (ex.: LING)")
	}
	return a.st.CreateWorkspace(r.Context(), strings.TrimSpace(in.Name), in.Key)
}

func (a *API) patchWorkspace(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct{ Name string }
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	return a.st.UpdateWorkspace(r.Context(), chi.URLParam(r, "ws"), strings.TrimSpace(in.Name))
}

func (a *API) deleteWorkspace(w http.ResponseWriter, r *http.Request) (any, error) {
	return nil, a.st.DeleteWorkspace(r.Context(), chi.URLParam(r, "ws"))
}

func (a *API) listRepos(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListRepos(r.Context(), chi.URLParam(r, "ws"))
}

func (a *API) saveRepo(w http.ResponseWriter, r *http.Request) (any, error) {
	var in store.Repo
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.ID = chi.URLParam(r, "id")
	if ws := chi.URLParam(r, "ws"); ws != "" {
		in.WorkspaceID = ws
	}
	in.URL = strings.TrimSpace(in.URL)
	if in.URL == "" {
		return nil, bad("informe a URL do repositório")
	}
	if strings.TrimSpace(in.Name) == "" {
		in.Name = strings.TrimSuffix(in.URL[strings.LastIndexAny(in.URL, "/:")+1:], ".git")
	}
	in.DefaultBranch = strings.TrimSpace(in.DefaultBranch)
	if in.DefaultBranch == "" {
		in.DefaultBranch = "main"
	}
	if strings.TrimSpace(in.TargetBranch) == "" {
		in.TargetBranch = in.DefaultBranch
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.ID != "" {
		cur, err := a.st.Repo(r.Context(), in.ID)
		if err != nil {
			return nil, err
		}
		if err := a.ensureAccess(r, cur.WorkspaceID); err != nil {
			return nil, err
		}
		in.WorkspaceID = cur.WorkspaceID
	}
	// Nome único no workspace: vira a pasta do repositório no diretório da issue.
	repos, _ := a.st.ListRepos(r.Context(), in.WorkspaceID)
	for _, o := range repos {
		if o.ID != in.ID && store.Slugify(o.Name, 40) == store.Slugify(in.Name, 40) {
			return nil, bad("já existe um repositório chamado %q neste workspace", o.Name)
		}
	}
	// Só aceita repositório git acessível com as credenciais do servidor.
	if err := a.run.CheckRemote(r.Context(), in.URL); err != nil {
		return nil, bad("não é um repositório git acessível pelo servidor: %v", err)
	}
	isNew := in.ID == ""
	repo, err := a.st.SaveRepo(r.Context(), in)
	if err == nil && isNew {
		a.st.AddRepoToOpenIssues(r.Context(), repo)
	}
	return repo, err
}

func (a *API) gitInfo(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.run.GitInfo(r.Context()), nil
}

func (a *API) deleteRepo(w http.ResponseWriter, r *http.Request) (any, error) {
	return nil, a.st.DeleteRepo(r.Context(), chi.URLParam(r, "id"))
}

func (a *API) repoBranches(w http.ResponseWriter, r *http.Request) (any, error) {
	repo, err := a.st.Repo(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, repo.WorkspaceID); err != nil {
		return nil, err
	}
	branches, err := a.run.Branches(r.Context(), repo)
	if err != nil {
		return nil, bad("não consegui acessar o repositório: %v", err)
	}
	return branches, nil
}

func (a *API) listLabels(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.LabelStats(r.Context(), chi.URLParam(r, "ws"))
}

func (a *API) updateLabel(w http.ResponseWriter, r *http.Request) (any, error) {
	l, err := a.st.Label(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, l.WorkspaceID); err != nil {
		return nil, err
	}
	var in struct{ Name, Color string }
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, bad("informe o nome da label")
	}
	return a.st.UpdateLabel(r.Context(), l.ID, strings.TrimSpace(in.Name), firstNonEmptyStr(in.Color, l.Color))
}

func (a *API) createLabel(w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct{ Name, Color string }
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, bad("informe o nome da label")
	}
	if in.Color == "" {
		in.Color = "#6366f1"
	}
	return a.st.CreateLabel(r.Context(), chi.URLParam(r, "ws"), strings.TrimSpace(in.Name), in.Color)
}

func (a *API) deleteLabel(w http.ResponseWriter, r *http.Request) (any, error) {
	l, err := a.st.Label(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, l.WorkspaceID); err != nil {
		return nil, err
	}
	return nil, a.st.DeleteLabel(r.Context(), l.ID)
}

// ---------- agentes e skills ----------

func (a *API) listAgents(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListAgents(r.Context())
}

func (a *API) saveAgent(w http.ResponseWriter, r *http.Request) (any, error) {
	var in store.Agent
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.ID = chi.URLParam(r, "id")
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, bad("dê um nome ao agente")
	}
	if in.Runtime != "codex" {
		in.Runtime = "claude"
	}
	if in.Avatar == "" {
		in.Avatar = "bot:violet"
	}
	return a.st.SaveAgent(r.Context(), in)
}

func (a *API) deleteAgent(w http.ResponseWriter, r *http.Request) (any, error) {
	return nil, a.st.ArchiveAgent(r.Context(), chi.URLParam(r, "id"))
}

func (a *API) listSkills(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.ListSkills(r.Context())
}

func (a *API) saveSkill(w http.ResponseWriter, r *http.Request) (any, error) {
	var in store.Skill
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.ID = chi.URLParam(r, "id")
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return nil, bad("dê um nome à skill")
	}
	in.Slug = store.Slugify(in.Name, 48)
	return a.st.SaveSkill(r.Context(), in)
}

func (a *API) deleteSkill(w http.ResponseWriter, r *http.Request) (any, error) {
	return nil, a.st.DeleteSkill(r.Context(), chi.URLParam(r, "id"))
}

// ---------- issues ----------

// issueQuery lê os filtros comuns do quadro, da lista e da busca.
func issueQuery(r *http.Request) store.IssueQuery {
	q := r.URL.Query()
	num := func(k string) int { n, _ := strconv.Atoi(q.Get(k)); return n }
	return store.IssueQuery{
		Stage: q.Get("stage"), Sort: q.Get("sort"), Offset: num("offset"), Limit: num("limit"),
		Q: q.Get("q"), Who: q.Get("who"), Label: q.Get("label"), UserID: userOf(r).ID,
	}
}

// listIssues: uma página (de uma etapa ou da busca em todas).
func (a *API) listIssues(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.st.PageIssues(r.Context(), chi.URLParam(r, "ws"), issueQuery(r))
}

// board: as primeiras N de cada etapa (cada uma na ordem escolhida para ela),
// o total de cada etapa com os mesmos filtros e quantas o agente está tocando.
// O resto vem por listIssues, etapa a etapa, quando a pessoa rola a coluna.
func (a *API) board(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	wsID := chi.URLParam(r, "ws")
	q := issueQuery(r)
	if q.Limit <= 0 || q.Limit > 100 {
		q.Limit = 30
	}
	sorts := map[string]string{}
	json.Unmarshal([]byte(r.URL.Query().Get("sorts")), &sorts)
	stages, err := a.st.Stages(ctx, wsID)
	if err != nil {
		return nil, err
	}
	counts, err := a.st.StageCounts(ctx, wsID, q)
	if err != nil {
		return nil, err
	}
	issues := []store.Issue{}
	for _, st := range stages {
		if counts[st.ID] == 0 {
			continue
		}
		sq := q
		sq.Stage, sq.Offset = st.ID, 0
		sq.Sort = sorts[st.ID]
		if sq.Sort == "" && st.Policy.Close != "" {
			sq.Sort = "updated" // encerradas: as mais recentes primeiro
		}
		page, err := a.st.PageIssues(ctx, wsID, sq)
		if err != nil {
			return nil, err
		}
		issues = append(issues, page...)
	}
	return map[string]any{"issues": issues, "counts": counts, "working": a.st.Working(ctx, wsID)}, nil
}

func (a *API) working(w http.ResponseWriter, r *http.Request) (any, error) {
	return map[string]int{"count": a.st.Working(r.Context(), chi.URLParam(r, "ws"))}, nil
}

func (a *API) publishIssue(is *store.Issue) {
	a.hub.Publish(hub.Event{Type: "issue", WorkspaceID: is.WorkspaceID, Data: is})
}

func (a *API) createIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	var in store.NewIssue
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return nil, bad("dê um título à issue")
	}
	wsID := chi.URLParam(r, "ws")
	if in.Status == "" {
		in.Status = a.st.FirstStage(r.Context(), wsID)
	}
	if !a.st.ValidStage(r.Context(), wsID, in.Status) {
		return nil, bad("etapa inválida")
	}
	if in.AgentID != nil && *in.AgentID == "" {
		in.AgentID = nil
	}
	repos, err := a.st.ListRepos(r.Context(), wsID)
	if err != nil {
		return nil, err
	}
	valid := map[string]bool{}
	for _, rp := range repos {
		valid[rp.ID] = true
	}
	for _, id := range in.RepoIDs {
		if !valid[id] {
			return nil, bad("repositório não pertence a este workspace")
		}
	}
	u := userOf(r)
	if err := a.guardNewIssue(r.Context(), u, wsID, &in); err != nil {
		return nil, err
	}
	is, err := a.st.CreateIssue(store.WithActor(r.Context(), u.ID), wsID, u.ID, in)
	if err != nil {
		return nil, err
	}
	a.publishIssue(is)
	a.ntf.IssueCreated(is, u, origin(r))
	// O que acontece ao entrar na etapa (ex.: rodar o agente) são as regras dela.
	return map[string]any{"issue": is}, nil
}

type issueDetail struct {
	Issue    *store.Issue    `json:"issue"`
	Runs     []store.Run     `json:"runs"`
	Comments []store.Comment `json:"comments"`
	Caps     map[string]any  `json:"caps"`
}

func (a *API) getIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	ctx := r.Context()
	var is *store.Issue
	var err error
	// Aceita o id ou a referência legível "LING-12".
	if ref := chi.URLParam(r, "id"); strings.Contains(ref, "-") && len(ref) < 20 {
		parts := strings.SplitN(ref, "-", 2)
		ws, werr := a.st.WorkspaceByKey(ctx, parts[0])
		n, nerr := strconv.Atoi(parts[1])
		if werr != nil || nerr != nil {
			return nil, store.ErrNotFound
		}
		is, err = a.st.IssueByNumber(ctx, ws.ID, n)
	} else {
		is, err = a.st.Issue(ctx, ref)
	}
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, is.WorkspaceID); err != nil {
		return nil, err
	}
	runs, err := a.st.ListRuns(ctx, is.ID)
	if err != nil {
		return nil, err
	}
	comments, err := a.st.ListComments(ctx, is.ID)
	return issueDetail{is, runs, comments, a.capsOf(ctx, userOf(r), is)}, err
}

// loadActable carrega a issue e confere a permissão do perfil e a política da etapa.
func (a *API) loadActable(r *http.Request, perm, what string) (*store.Issue, error) {
	is, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	u := userOf(r)
	if err := need(u, perm, what); err != nil {
		return nil, err
	}
	return is, a.canAct(r.Context(), u, is)
}

func (a *API) loadIssue(r *http.Request) (*store.Issue, error) {
	is, err := a.st.Issue(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	return is, a.ensureAccess(r, is.WorkspaceID)
}

func (a *API) patchIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	before, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	var patch map[string]any
	if err := decode(r, &patch); err != nil {
		return nil, err
	}
	if s, ok := patch["status"].(string); ok && !a.st.ValidStage(r.Context(), before.WorkspaceID, s) {
		return nil, bad("etapa inválida")
	}
	if t, ok := patch["title"].(string); ok && strings.TrimSpace(t) == "" {
		return nil, bad("o título não pode ficar vazio")
	}
	// Permissão de cada campo + política da etapa atual (e da de destino, se mudar).
	ctx, u := r.Context(), userOf(r)
	if err := a.canAct(ctx, u, before); err != nil {
		return nil, err
	}
	next := *before
	for k, v := range patch {
		if k == "status" && v == before.Status {
			continue
		}
		if err := a.canField(ctx, u, before, k); err != nil {
			return nil, err
		}
		switch k {
		case "agentId":
			if id, _ := v.(string); id != "" {
				next.AgentID = &id
			} else {
				next.AgentID = nil
			}
		case "assigneeId":
			if err := a.checkAssignee(ctx, before.WorkspaceID, v); err != nil {
				return nil, err
			}
			if id, _ := v.(string); id != "" {
				next.AssigneeID = &id
			} else {
				next.AssigneeID = nil
			}
		case "description":
			next.Description, _ = v.(string)
		}
	}
	if to, ok := patch["status"].(string); ok && to != before.Status {
		if err := a.canEnter(ctx, u, &next, to); err != nil {
			return nil, err
		}
	}
	is, err := a.st.PatchIssue(store.WithActor(r.Context(), userOf(r).ID), before.ID, patch)
	if err != nil {
		return nil, err
	}
	a.publishIssue(is)
	// Mudou de etapa: as regras dela (rodar agente, parar…) rodam pelo motor.
	return map[string]any{"issue": is}, nil
}

func (a *API) deleteIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadActable(r, "issue.delete", "excluir issues")
	if err != nil {
		return nil, err
	}
	a.run.Discard(r.Context(), is)
	if err := a.st.DeleteIssue(r.Context(), is.ID); err != nil {
		return nil, err
	}
	a.hub.Publish(hub.Event{Type: "issue_deleted", WorkspaceID: is.WorkspaceID, Data: map[string]string{"id": is.ID}})
	return nil, nil
}

func (a *API) runIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadActable(r, "issue.run", "executar agentes")
	if err != nil {
		return nil, err
	}
	var in struct{ AgentID, Kind, Request string }
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	switch in.Kind {
	case "initial", "followup", "conflict":
	default:
		in.Kind = "initial"
	}
	if in.AgentID != "" && (is.AgentID == nil || *is.AgentID != in.AgentID) {
		is, _ = a.st.PatchIssue(r.Context(), is.ID, map[string]any{"agentId": in.AgentID})
	}
	u := userOf(r)
	run, err := a.run.Enqueue(r.Context(), is, in.AgentID, in.Kind, in.Request, &u.ID)
	if err != nil {
		return nil, bad("%s", err.Error())
	}
	a.run.PublishIssue(r.Context(), is.ID)
	return run, nil
}

func (a *API) cancelIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadActable(r, "issue.run", "cancelar execuções")
	if err != nil {
		return nil, err
	}
	if is.ActiveRun == nil {
		return nil, bad("nada rodando")
	}
	return nil, a.run.Cancel(r.Context(), *is.ActiveRun)
}

func (a *API) mergeIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadActable(r, "issue.merge", "fazer merge")
	if err != nil {
		return nil, err
	}
	var in struct {
		Targets map[string]string `json:"targets"` // repoID → branch de destino
	}
	decode(r, &in)
	res, err := a.run.Merge(r.Context(), is, in.Targets, userOf(r))
	if err != nil {
		if res != nil {
			return map[string]any{"result": res, "error": err.Error()}, nil
		}
		return nil, bad("%s", err.Error())
	}
	return res, nil
}

// setIssueRepos troca os repositórios da issue (todos, ou só os escolhidos) e
// as branches de cada um.
func (a *API) setIssueRepos(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadActable(r, "issue.repos", "escolher repositórios")
	if err != nil {
		return nil, err
	}
	var in struct {
		All   bool               `json:"all"`
		Repos []store.RepoChoice `json:"repos"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if err := a.canField(r.Context(), userOf(r), is, "repos"); err != nil {
		return nil, err
	}
	if !in.All && len(in.Repos) == 0 {
		return nil, bad("escolha pelo menos um repositório")
	}
	if err := a.st.SetIssueRepos(r.Context(), is.ID, in.All, in.Repos); err != nil {
		return nil, err
	}
	is, err = a.st.Issue(r.Context(), is.ID)
	if err == nil {
		a.publishIssue(is)
	}
	return is, err
}

func (a *API) discardIssue(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadActable(r, "issue.merge", "descartar branches")
	if err != nil {
		return nil, err
	}
	a.run.Discard(r.Context(), is)
	a.run.PublishIssue(r.Context(), is.ID)
	return nil, nil
}

func (a *API) issueDiff(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	return a.run.Diff(r.Context(), is), nil
}

func (a *API) addComment(w http.ResponseWriter, r *http.Request) (any, error) {
	is, err := a.loadIssue(r)
	if err != nil {
		return nil, err
	}
	var in struct {
		Body        string `json:"body"`
		SendToAgent bool   `json:"sendToAgent"`
		AgentID     string `json:"agentId"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Body) == "" {
		return nil, bad("comentário vazio")
	}
	u := userOf(r)
	if err := need(u, "issue.comment", "comentar"); err != nil {
		return nil, err
	}
	if err := a.canAct(r.Context(), u, is); err != nil {
		return nil, err
	}
	// Verifica antes de gravar, para não deixar um pedido "órfão" se o agente estiver ocupado.
	if in.SendToAgent && !u.Can("issue.run") {
		return nil, httpError{status: http.StatusForbidden, msg: "seu perfil não pode executar agentes"}
	}
	if in.SendToAgent && in.AgentID != "" && (is.AgentID == nil || *is.AgentID != in.AgentID) {
		if err := a.canField(r.Context(), u, is, "agentId"); err != nil {
			return nil, err
		}
	}
	if in.SendToAgent && is.ActiveRun != nil {
		return nil, httpError{status: http.StatusConflict, msg: runner.ErrBusy.Error()}
	}
	c, err := a.st.AddComment(r.Context(), store.Comment{IssueID: is.ID, UserID: &u.ID, Kind: "comment", Body: in.Body})
	if err != nil {
		return nil, err
	}
	a.hub.Publish(hub.Event{Type: "comment", WorkspaceID: is.WorkspaceID, Data: c})
	a.st.Emit(r.Context(), store.Event{Kind: "commented", IssueID: is.ID, ActorID: &u.ID})
	if in.SendToAgent {
		kind := "followup"
		if is.Branch == "" || len(mustRuns(a, r, is.ID)) == 0 {
			kind = "initial"
		}
		if _, err := a.run.Enqueue(r.Context(), is, in.AgentID, kind, in.Body, &u.ID); err != nil {
			return map[string]any{"comment": c, "warning": err.Error()}, nil
		}
		if in.AgentID != "" {
			a.st.PatchIssue(r.Context(), is.ID, map[string]any{"agentId": in.AgentID})
		}
		a.run.PublishIssue(r.Context(), is.ID)
	}
	return map[string]any{"comment": c}, nil
}

func mustRuns(a *API, r *http.Request, issueID string) []store.Run {
	runs, _ := a.st.ListRuns(r.Context(), issueID)
	return runs
}

func (a *API) runEvents(w http.ResponseWriter, r *http.Request) (any, error) {
	run, err := a.st.Run(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return nil, err
	}
	if err := a.ensureAccess(r, run.WorkspaceID); err != nil {
		return nil, err
	}
	return a.st.Events(r.Context(), run.ID)
}

// ---------- analytics e runtimes ----------

// Analytics tem dois níveis, cada um com duas permissões independentes:
//   - do workspace (analytics.view): só os números da própria pessoa;
//     com analytics.team, os de todo mundo ou os de uma pessoa escolhida;
//   - geral, de todos os workspaces que a pessoa enxerga (analytics.global):
//     só os próprios; com analytics.global_team, de todo mundo ou de alguém.
//
// ?person=me | all | <id>. Sem a permissão de equipe, vale sempre "me".
func (a *API) workspaceAnalytics(w http.ResponseWriter, r *http.Request) (any, error) {
	person, err := analyticsPerson(r, "analytics.team")
	if err != nil {
		return nil, err
	}
	return a.st.Analytics(r.Context(), []string{chi.URLParam(r, "ws")}, analyticsDays(r), person)
}

func (a *API) globalAnalytics(w http.ResponseWriter, r *http.Request) (any, error) {
	person, err := analyticsPerson(r, "analytics.global_team")
	if err != nil {
		return nil, err
	}
	ids, err := a.st.WorkspaceIDsFor(r.Context(), userOf(r))
	if err != nil {
		return nil, err
	}
	return a.st.Analytics(r.Context(), ids, analyticsDays(r), person)
}

func analyticsDays(r *http.Request) int {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 || days > 365 {
		days = 30
	}
	return days
}

// analyticsPerson: de quem são os números ("" = todo mundo).
func analyticsPerson(r *http.Request, team string) (string, error) {
	u := userOf(r)
	p := r.URL.Query().Get("person")
	switch {
	case p == "" || p == "me" || p == u.ID:
		if p == "" && u.Can(team) {
			return "", nil
		}
		return u.ID, nil
	case u.Can(team):
		if p == "all" {
			return "", nil
		}
		return p, nil
	}
	return "", forbidden("seu perfil só vê os próprios números no Analytics")
}

// Catálogo de modelos por runtime; ?refresh=1 consulta os CLIs de novo (quem configura agentes).
func (a *API) runtimeModels(w http.ResponseWriter, r *http.Request) (any, error) {
	u := userOf(r)
	force := r.URL.Query().Get("refresh") == "1" && (u.Can("agent.create") || u.Can("agent.update"))
	return a.run.Models(r.Context(), force), nil
}

func (a *API) runtimes(w http.ResponseWriter, r *http.Request) (any, error) {
	return a.run.Runtimes(r.Context()), nil
}

// ---------- tempo real (SSE) ----------

func (a *API) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming não suportado", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // nginx: não segurar o stream
	ch := a.hub.Subscribe(chi.URLParam(r, "ws"))
	defer a.hub.Unsubscribe(ch)
	fmt.Fprint(w, ": ok\n\n")
	flusher.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// ---------- e-mail ----------

// origin deduz a URL pública do Multica a partir da requisição (atrás de
// proxy, usa X-Forwarded-Proto). Vale para os links quando o admin não
// definiu a URL nos parâmetros de e-mail.
func origin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = strings.Split(p, ",")[0]
	}
	return scheme + "://" + r.Host
}

type emailSettingsView struct {
	notify.Settings
	HasPassword bool          `json:"hasPassword"`
	Status      notify.Status `json:"status"`
	// Regras de e-mail ativas: com o envio desligado, nenhuma delas manda nada.
	NotifyRules int `json:"notifyRules"`
}

func (a *API) getEmailSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := a.ntf.Settings(r.Context())
	if err != nil {
		return nil, err
	}
	rules := a.st.EnabledNotifyRules(r.Context())
	if !userOf(r).Can("settings.manage") {
		return map[string]any{"enabled": c.Enabled, "notifyRules": rules}, nil
	}
	has := c.Password != ""
	c.Password = "" // a senha nunca volta para o navegador
	return emailSettingsView{Settings: c, HasPassword: has, Status: a.ntf.Status(), NotifyRules: rules}, nil
}

// emailForm lê o formulário; senha vazia mantém a que já está salva.
func (a *API) emailForm(r *http.Request) (notify.Settings, error) {
	var in notify.Settings
	if err := decode(r, &in); err != nil {
		return in, err
	}
	in.Host, in.From, in.Username = strings.TrimSpace(in.Host), strings.TrimSpace(in.From), strings.TrimSpace(in.Username)
	in.AppURL = strings.TrimRight(strings.TrimSpace(in.AppURL), "/")
	if in.Password == "" {
		cur, err := a.ntf.Settings(r.Context())
		if err != nil {
			return in, err
		}
		in.Password = cur.Password
	}
	return in, nil
}

func (a *API) saveEmailSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	in, err := a.emailForm(r)
	if err != nil {
		return nil, err
	}
	if in.Enabled {
		if err := in.Validate(); err != nil {
			return nil, bad("%s", err.Error())
		}
	}
	if err := a.ntf.Save(r.Context(), in); err != nil {
		return nil, err
	}
	return a.getEmailSettings(w, r)
}

func (a *API) testEmailSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	in, err := a.emailForm(r)
	if err != nil {
		return nil, err
	}
	if err := in.Validate(); err != nil {
		return nil, bad("%s", err.Error())
	}
	to := userOf(r).Email
	if err := a.ntf.Test(r.Context(), in, to); err != nil {
		return nil, bad("falhou: %s", err.Error())
	}
	return map[string]string{"sentTo": to}, nil
}
