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
	{"issue.update", "Issues", "Editar, mover e comentar issues"},
	{"issue.delete", "Issues", "Excluir issues"},
	{"issue.run", "Issues", "Executar agentes (rodar, pedir ajuste, cancelar)"},
	{"issue.merge", "Issues", "Fazer merge e descartar branches"},
	{"agent.create", "Agentes", "Criar agentes"},
	{"agent.update", "Agentes", "Editar agentes"},
	{"agent.delete", "Agentes", "Arquivar agentes"},
	{"skill.create", "Skills", "Criar skills"},
	{"skill.update", "Skills", "Editar skills"},
	{"skill.delete", "Skills", "Excluir skills"},
	{"workspace.create", "Workspaces", "Criar workspaces"},
	{"workspace.update", "Workspaces", "Renomear workspaces"},
	{"workspace.delete", "Workspaces", "Excluir workspaces"},
	{"workspace.all", "Workspaces", "Ver todos os workspaces (sem precisar de vínculo)"},
	{"member.manage", "Workspaces", "Vincular e desvincular pessoas"},
	{"repo.create", "Repositórios", "Adicionar repositórios"},
	{"repo.update", "Repositórios", "Editar repositórios"},
	{"repo.delete", "Repositórios", "Remover repositórios"},
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
