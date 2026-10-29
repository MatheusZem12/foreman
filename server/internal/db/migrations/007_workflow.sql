-- Configurable workflow: custom stages per workspace, rules that fire on entering a
-- stage, the fixed "waiting" stage (Waiting for you) and the outcome the AI declares at
-- the end of each run.

-- issues.status now also accepts the id of a custom stage.
alter table issues drop constraint if exists issues_status_check;

create table stages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  color        text not null default '#a78bfa',
  position     double precision not null,      -- between the system stages' positions
  created_at   timestamptz not null default now()
);
create index stages_ws_idx on stages(workspace_id);

create table rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stage        text not null,                  -- a system stage (e.g. in_review) or a custom stage's uuid
  action       text not null check (action in ('notify', 'webhook', 'move', 'run_agent', 'open_pr', 'merge', 'script')),
  config       jsonb not null default '{}',
  enabled      boolean not null default true,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);
create index rules_ws_stage_idx on rules(workspace_id, stage);

-- What the AI declared when it finished: done | waiting | incomplete (empty = not declared).
alter table runs
  add column outcome      text not null default '',
  add column outcome_note text not null default '';

-- Default rules: done does the merge (the previous behaviour) and, when the AI needs
-- someone, whoever asked gets an e-mail.
insert into rules(workspace_id, stage, action, config, position)
  select id, 'done', 'merge', '{}', 0 from workspaces;
insert into rules(workspace_id, stage, action, config, position)
  select id, 'waiting', 'notify', '{"to": "requester"}', 0 from workspaces;

update roles set permissions = array_append(permissions, 'workflow.manage')
  where name = 'Administrator' and not ('workflow.manage' = any(permissions));
