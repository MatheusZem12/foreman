package store

import "context"

// ListWorkspacesFor returns every workspace for whoever has
// workspace.all and only the linked ones for everyone else.
func (s *Store) ListWorkspacesFor(ctx context.Context, u *User) ([]Workspace, error) {
	if u.Can("workspace.all") {
		return s.ListWorkspaces(ctx)
	}
	return many[Workspace](ctx, s, `select w.* from workspaces w join workspace_members m on m.workspace_id = w.id
		where m.user_id = $1 order by w.name`, u.ID)
}

// WorkspaceIDsFor: nil for whoever sees everything (no filter), a list for everyone else.
func (s *Store) WorkspaceIDsFor(ctx context.Context, u *User) ([]string, error) {
	if u.Can("workspace.all") {
		return nil, nil
	}
	ids := []string{}
	rows, err := s.DB.Query(ctx, `select workspace_id::text from workspace_members where user_id = $1`, u.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) CanAccess(ctx context.Context, u *User, wsID string) bool {
	if u.Can("workspace.all") {
		return true
	}
	var ok bool
	s.DB.QueryRow(ctx, `select exists(select 1 from workspace_members where workspace_id = $1 and user_id = $2)`, wsID, u.ID).Scan(&ok)
	return ok
}

// Members = linked + whoever sees every workspace.
// seesAll is the SQL condition equivalent to Can("workspace.all") over user_view.
const seesAll = `('*' = any(u.permissions) or 'workspace.all' = any(u.permissions))`

type Member struct {
	User
	Linked bool `db:"linked" json:"linked"`
}

func (s *Store) ListMembers(ctx context.Context, wsID string) ([]Member, error) {
	return many[Member](ctx, s, `select u.*, (m.user_id is not null) as linked from user_view u
		left join workspace_members m on m.user_id = u.id and m.workspace_id = $1
		where `+seesAll+` or m.user_id is not null order by u.is_owner desc, u.name`, wsID)
}

func (s *Store) AddMember(ctx context.Context, wsID, userID string) error {
	_, err := s.DB.Exec(ctx, `insert into workspace_members(workspace_id, user_id) values($1, $2) on conflict do nothing`, wsID, userID)
	return err
}

func (s *Store) RemoveMember(ctx context.Context, wsID, userID string) error {
	_, err := s.DB.Exec(ctx, `delete from workspace_members where workspace_id = $1 and user_id = $2`, wsID, userID)
	return err
}

// UserWithWorkspaces is the user as shown in user management.
type UserWithWorkspaces struct {
	User
	WorkspaceIDs []string `db:"workspace_ids" json:"workspaceIds"`
}

func (s *Store) ListUsersWithWorkspaces(ctx context.Context) ([]UserWithWorkspaces, error) {
	return many[UserWithWorkspaces](ctx, s, `select u.*,
		coalesce((select array_agg(m.workspace_id::text) from workspace_members m where m.user_id = u.id), '{}') as workspace_ids
		from user_view u order by u.created_at`)
}

func (s *Store) SetUserWorkspaces(ctx context.Context, userID string, wsIDs []string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `delete from workspace_members where user_id = $1`, userID); err != nil {
		return err
	}
	for _, ws := range wsIDs {
		if _, err := tx.Exec(ctx, `insert into workspace_members(workspace_id, user_id) values($1, $2) on conflict do nothing`, ws, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Ends a user's sessions (password reset…).
func (s *Store) DeleteUserSessions(ctx context.Context, userID string) error {
	_, err := s.DB.Exec(ctx, `delete from sessions where user_id = $1`, userID)
	return err
}

func (s *Store) Label(ctx context.Context, id string) (*Label, error) {
	return one[Label](ctx, s, `select * from labels where id = $1`, id)
}
