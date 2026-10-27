-- Esquema inicial. Agentes e skills são globais (valem para todos os
-- workspaces); repositórios, labels e issues pertencem a um workspace.

create extension if not exists pgcrypto;

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  is_admin      boolean not null default false,
  about         text not null default '',
  created_at    timestamptz not null default now()
);

create table sessions (
  token      text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions(user_id);

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  key        text not null unique,          -- prefixo das issues: LING-12
  issue_seq  integer not null default 0,
  created_at timestamptz not null default now()
);

create table repos (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  name               text not null,
  url                text not null,
  default_branch     text not null default 'main',   -- de onde as issues partem
  target_branch      text not null default 'main',   -- onde o merge cai por padrão
  protected_branches text[] not null default '{}',   -- nunca recebem merge do Multica
  setup_script       text not null default '',
  env_files          jsonb not null default '[]',    -- [{path, content}] escritos no worktree, nunca commitados
  instructions       text not null default '',
  created_at         timestamptz not null default now()
);
create index repos_ws_idx on repos(workspace_id);

create table skills (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text not null default '',
  content     text not null default '',
  files       jsonb not null default '[]',   -- [{path, content}] scripts ao lado do SKILL.md
  always      boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table agents (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  avatar         text not null default '🤖',
  runtime        text not null default 'claude' check (runtime in ('claude', 'codex')),
  model          text not null default '',
  effort         text not null default '',
  max_budget_usd numeric(10, 2),
  permission     text not null default 'full' check (permission in ('full', 'edits')),
  instructions   text not null default '',
  skill_ids      uuid[] not null default '{}',
  extra_args     text not null default '',
  archived       boolean not null default false,
  created_at     timestamptz not null default now()
);

create table labels (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  color        text not null default '#6366f1',
  unique (workspace_id, name)
);

create table issues (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  number            integer not null,
  title             text not null,
  description       text not null default '',
  status            text not null default 'backlog'
                    check (status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled')),
  priority          smallint not null default 0,  -- 0 nenhuma, 1 urgente, 2 alta, 3 média, 4 baixa
  position          double precision not null default 0,
  agent_id          uuid references agents(id) on delete set null,
  repo_id           uuid references repos(id) on delete set null,
  base_branch       text not null default '',
  target_branch     text not null default '',
  branch            text not null default '',
  label_ids         uuid[] not null default '{}',
  skill_ids         uuid[] not null default '{}',
  summary           text not null default '',     -- RESUMO cumulativo mantido pelo agente
  merged_into       text not null default '',
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, number)
);
create index issues_ws_status_idx on issues(workspace_id, status, position);

create table runs (
  id            uuid primary key default gen_random_uuid(),
  issue_id      uuid not null references issues(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  agent_id      uuid references agents(id) on delete set null,
  agent_name    text not null default '',
  runtime       text not null default '',
  model         text not null default '',
  kind          text not null check (kind in ('initial', 'followup', 'conflict')),
  request       text not null default '',
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error         text not null default '',
  cost_usd      numeric(12, 6) not null default 0,
  input_tokens  bigint not null default 0,
  cached_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  commit_sha    text not null default '',
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  ended_at      timestamptz
);
create index runs_issue_idx on runs(issue_id, created_at);
create index runs_queue_idx on runs(status, created_at);
create index runs_ws_created_idx on runs(workspace_id, created_at);

create table run_events (
  id         bigserial primary key,
  run_id     uuid not null references runs(id) on delete cascade,
  kind       text not null,   -- text | tool | out | error | info | result
  body       text not null,
  created_at timestamptz not null default now()
);
create index run_events_run_idx on run_events(run_id, id);

create table comments (
  id         uuid primary key default gen_random_uuid(),
  issue_id   uuid not null references issues(id) on delete cascade,
  user_id    uuid references users(id) on delete set null,
  agent_id   uuid references agents(id) on delete set null,
  run_id     uuid references runs(id) on delete set null,
  kind       text not null default 'comment' check (kind in ('comment', 'agent', 'system')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index comments_issue_idx on comments(issue_id, created_at);
