-- Each person's view preferences (e.g. how a workspace's board is arranged). Looks only:
-- nothing here changes a rule, a stage or a permission.
create table user_prefs (
  user_id    uuid not null references users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
