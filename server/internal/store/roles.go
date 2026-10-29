package store

import "context"

// Permission is an action the owner can grant to a role.
type Permission struct {
	ID    string `json:"id"`
	Group string `json:"group"`
	Label string `json:"label"`
}

// Permissions is the catalog, in the order the roles screen shows it.
var Permissions = []Permission{
	{"issue.create", "Issues", "Create issues"},
	{"issue.edit", "Issues", "Edit title, description and README"},
	{"issue.move", "Issues", "Move issues between stages and reorder"},
	{"issue.comment", "Issues", "Comment"},
	{"issue.priority", "Issues", "Set priority"},
	{"issue.labels", "Issues", "Set labels"},
	{"issue.agent", "Issues", "Choose the issue's agent"},
	{"issue.repos", "Issues", "Choose the issue's repositories and branches"},
	{"issue.assign", "Issues", "Set the assignee"},
	{"issue.run", "Issues", "Run agents (run, ask for changes, reply, cancel)"},
	{"issue.approve", "Issues", "Approve issues in stages with approval"},
	{"issue.merge", "Issues", "Merge and discard branches"},
	{"issue.delete", "Issues", "Delete issues"},
	{"label.view", "Labels", "View the labels screen"},
	{"label.create", "Labels", "Create labels"},
	{"label.update", "Labels", "Rename and recolor labels"},
	{"label.delete", "Labels", "Delete labels (removed from issues)"},
	{"analytics.view", "Analytics", "View the workspace Analytics (own numbers only)"},
	{"analytics.team", "Analytics", "In the workspace Analytics, see everyone's numbers and each person's"},
	{"analytics.global", "Analytics", "View the overall Analytics across every workspace they can access (own numbers only)"},
	{"analytics.global_team", "Analytics", "In the overall Analytics, see everyone's numbers and each person's"},
	{"workflow.view", "Workflow", "View the workflow and automations (read-only)"},
	{"workflow.manage", "Workflow", "Configure stages, access and automations (includes scripts)"},
	{"workflow.duplicate", "Workflow", "Copy the workflow from one workspace to another"},
	{"agent.view", "Agents", "View agents"},
	{"agent.create", "Agents", "Create agents"},
	{"agent.update", "Agents", "Edit agents"},
	{"agent.delete", "Agents", "Archive agents"},
	{"skill.view", "Skills", "View skills"},
	{"skill.create", "Skills", "Create skills"},
	{"skill.update", "Skills", "Edit skills and link them to agents"},
	{"skill.delete", "Skills", "Delete skills"},
	{"workspace.view", "Workspaces", "View the workspace's repositories, people and labels"},
	{"workspace.create", "Workspaces", "Create workspaces"},
	{"workspace.update", "Workspaces", "Rename workspaces"},
	{"workspace.delete", "Workspaces", "Delete workspaces"},
	{"workspace.all", "Workspaces", "See every workspace (without being added)"},
	{"member.manage", "Workspaces", "Add and remove people"},
	{"repo.create", "Repositories", "Add repositories"},
	{"repo.update", "Repositories", "Edit repositories"},
	{"repo.delete", "Repositories", "Remove repositories"},
	{"user.view", "Users", "View users and each one's profile (what they do in each workspace)"},
	{"user.create", "Users", "Create users"},
	{"user.update", "Users", "Edit users, passwords and roles"},
	{"user.delete", "Users", "Remove users"},
	{"settings.manage", "Server", "Configure email and server"},
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
