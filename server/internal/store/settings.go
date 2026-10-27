package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// GetSetting lê o parâmetro key em dst. Se não existir, dst fica como está
// (os valores padrão de quem chamou).
func (s *Store) GetSetting(ctx context.Context, key string, dst any) error {
	var raw []byte
	err := s.DB.QueryRow(ctx, `select value from settings where key = $1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

func (s *Store) SetSetting(ctx context.Context, key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx, `insert into settings(key, value) values($1, $2)
		on conflict (key) do update set value = excluded.value, updated_at = now()`, key, raw)
	return err
}

func (s *Store) SetEmailNotifications(ctx context.Context, userID string, on bool) error {
	_, err := s.DB.Exec(ctx, `update users set email_notifications = $2 where id = $1`, userID, on)
	return err
}

// Recipient é quem recebe o aviso de um workspace.
type Recipient struct {
	Email string `db:"email"`
	Name  string `db:"name"`
}

// NotificationRecipients: todos que enxergam o workspace (vinculados + quem vê tudo)
// e não desligaram o e-mail no perfil, menos quem disparou o aviso.
func (s *Store) NotificationRecipients(ctx context.Context, wsID, exceptUserID string) ([]Recipient, error) {
	return many[Recipient](ctx, s, `select u.email, u.name from user_view u
		left join workspace_members m on m.user_id = u.id and m.workspace_id = $1
		where (`+seesAll+` or m.user_id is not null) and u.email_notifications and u.id::text <> $2
		order by u.name`, wsID, exceptUserID)
}
