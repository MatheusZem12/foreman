-- Fluxo configurável: etapas personalizadas por workspace, regras que disparam
-- ao entrar numa etapa, a etapa fixa "waiting" (Aguardando você) e o resultado
-- que a IA declara ao fim de cada execução.

-- issues.status passa a aceitar também o id de uma etapa personalizada.
alter table issues drop constraint if exists issues_status_check;

create table stages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  color        text not null default '#a78bfa',
  position     double precision not null,      -- entre as posições das etapas do sistema
  created_at   timestamptz not null default now()
);
create index stages_ws_idx on stages(workspace_id);

create table rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stage        text not null,                  -- etapa do sistema (ex.: in_review) ou uuid de etapa personalizada
  action       text not null check (action in ('notify', 'webhook', 'move', 'run_agent', 'open_pr', 'merge', 'script')),
  config       jsonb not null default '{}',
  enabled      boolean not null default true,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);
create index rules_ws_stage_idx on rules(workspace_id, stage);

-- O que a IA declarou ao terminar: done | waiting | incomplete (vazio = não declarou).
alter table runs
  add column outcome      text not null default '',
  add column outcome_note text not null default '';

-- Regras padrão: concluir faz o merge (o comportamento de antes) e, quando a IA
-- precisa de alguém, quem pediu recebe um e-mail.
insert into rules(workspace_id, stage, action, config, position)
  select id, 'done', 'merge', '{}', 0 from workspaces;
insert into rules(workspace_id, stage, action, config, position)
  select id, 'waiting', 'notify', '{"to": "requester"}', 0 from workspaces;

update roles set permissions = array_append(permissions, 'workflow.manage')
  where name = 'Administrador' and not ('workflow.manage' = any(permissions));
