package store

import "context"

// Permission é uma ação que o dono pode liberar para um perfil.
type Permission struct {
	ID    string `json:"id"`
	Group string `json:"group"`
	Label string `json:"label"`
}

// Permissions é o catálogo, na ordem em que a tela de perfis mostra.
var Permissions = []Permission{
	{"issue.create", "Issues", "Criar issues"},
	{"issue.edit", "Issues", "Editar título, descrição e README"},
	{"issue.move", "Issues", "Mover issues entre etapas e reordenar"},
	{"issue.comment", "Issues", "Comentar"},
	{"issue.priority", "Issues", "Definir prioridade"},
	{"issue.labels", "Issues", "Definir labels"},
	{"issue.agent", "Issues", "Escolher o agente da issue"},
	{"issue.repos", "Issues", "Escolher repositórios e branches da issue"},
	{"issue.assign", "Issues", "Definir o responsável"},
	{"issue.run", "Issues", "Executar agentes (rodar, pedir ajuste, responder, cancelar)"},
	{"issue.approve", "Issues", "Aprovar issues em etapas com aprovação"},
	{"issue.merge", "Issues", "Fazer merge e descartar branches"},
	{"issue.delete", "Issues", "Excluir issues"},
	{"label.view", "Labels", "Ver a tela de labels"},
	{"label.create", "Labels", "Criar labels"},
	{"label.update", "Labels", "Renomear e trocar a cor das labels"},
	{"label.delete", "Labels", "Apagar labels (saem das issues)"},
	{"analytics.view", "Telas", "Ver Analytics"},
	{"workflow.view", "Fluxo", "Ver o fluxo e as automações (só leitura)"},
	{"workflow.manage", "Fluxo", "Configurar etapas, acessos e automações (inclui scripts)"},
	{"workflow.duplicate", "Fluxo", "Copiar o fluxo de um workspace para outro"},
	{"agent.view", "Agentes", "Ver agentes"},
	{"agent.create", "Agentes", "Criar agentes"},
	{"agent.update", "Agentes", "Editar agentes"},
	{"agent.delete", "Agentes", "Arquivar agentes"},
	{"skill.view", "Skills", "Ver skills"},
	{"skill.create", "Skills", "Criar skills"},
	{"skill.update", "Skills", "Editar skills e vincular a agentes"},
	{"skill.delete", "Skills", "Excluir skills"},
	{"workspace.view", "Workspaces", "Ver repositórios, pessoas e labels do workspace"},
	{"workspace.create", "Workspaces", "Criar workspaces"},
	{"workspace.update", "Workspaces", "Renomear workspaces"},
	{"workspace.delete", "Workspaces", "Excluir workspaces"},
	{"workspace.all", "Workspaces", "Ver todos os workspaces (sem precisar de vínculo)"},
	{"member.manage", "Workspaces", "Vincular e desvincular pessoas"},
	{"repo.create", "Repositórios", "Adicionar repositórios"},
	{"repo.update", "Repositórios", "Editar repositórios"},
	{"repo.delete", "Repositórios", "Remover repositórios"},
	{"user.view", "Usuários", "Ver usuários e o perfil de cada um (o que faz em cada workspace)"},
	{"user.create", "Usuários", "Criar usuários"},
	{"user.update", "Usuários", "Editar usuários, senhas e perfis"},
	{"user.delete", "Usuários", "Remover usuários"},
	{"settings.manage", "Servidor", "Configurar e-mail e servidor"},
}

func ValidPermission(id string) bool {
	for _, p := range Permissions {
		if p.ID == id {
			return true
		}
	}
	return false
}

type Role struct {
	ID          string   `db:"id" json:"id"`
	Name        string   `db:"name" json:"name"`
	Permissions []string `db:"permissions" json:"permissions"`
	Users       int      `db:"users" json:"users"`
}

const roleSelect = `select r.id, r.name, r.permissions, (select count(*) from users u where u.role_id = r.id)::int as users from roles r`

func (s *Store) ListRoles(ctx context.Context) ([]Role, error) {
	return many[Role](ctx, s, roleSelect+` order by r.created_at`)
}

func (s *Store) Role(ctx context.Context, id string) (*Role, error) {
	return one[Role](ctx, s, roleSelect+` where r.id = $1`, id)
}

func (s *Store) RoleByName(ctx context.Context, name string) (*Role, error) {
	return one[Role](ctx, s, roleSelect+` where r.name = $1`, name)
}

func (s *Store) SaveRole(ctx context.Context, r Role) (*Role, error) {
	id := r.ID
	var err error
	if id == "" {
		err = s.DB.QueryRow(ctx, `insert into roles(name, permissions) values($1, $2) returning id`, r.Name, nz(r.Permissions)).Scan(&id)
	} else {
		_, err = s.DB.Exec(ctx, `update roles set name = $2, permissions = $3 where id = $1`, id, r.Name, nz(r.Permissions))
	}
	if err != nil {
		return nil, err
	}
	return s.Role(ctx, id)
}

func (s *Store) DeleteRole(ctx context.Context, id string) error {
	_, err := s.DB.Exec(ctx, `delete from roles where id = $1`, id)
	return err
}

func (s *Store) SetUserRole(ctx context.Context, userID string, roleID *string) error {
	_, err := s.DB.Exec(ctx, `update users set role_id = $2 where id = $1`, userID, roleID)
	return err
}
