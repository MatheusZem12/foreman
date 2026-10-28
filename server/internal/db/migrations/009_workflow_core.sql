-- Núcleo do fluxo: cada workspace tem todas as suas etapas (as do sistema
-- também, para poder reordenar, renomear e configurar), com políticas de quem
-- pode fazer o quê em cada uma; regras com vários gatilhos e condições;
-- responsável humano por issue; aprovações; entrada de issues por webhook;
-- e permissões finas no lugar do antigo issue.update.

-- ---------- etapas: uma linha por etapa por workspace ----------
alter table stages drop constraint stages_pkey;
alter table stages alter column id drop default;
alter table stages alter column id type text using id::text;
alter table stages add column system boolean not null default false;
-- policy: quem traz issues para cá, quem mexe nelas aqui, campos travados,
-- requisitos, limite de issues, aprovações e responsáveis (ver store.StagePolicy).
alter table stages add column policy jsonb not null default '{}';
alter table stages add primary key (workspace_id, id);

insert into stages(workspace_id, id, name, color, position, system)
  select w.id, s.id, s.name, s.color, s.pos, true
  from workspaces w cross join (values
    ('backlog', 'Backlog', '#8b8b94', 10), ('todo', 'A fazer', '#d4d4d8', 20),
    ('in_progress', 'Em andamento', '#f5b83d', 30), ('waiting', 'Aguardando você', '#fb923c', 40),
    ('in_review', 'Em revisão', '#4ade80', 50), ('blocked', 'Bloqueada', '#f87171', 60),
    ('done', 'Concluída', '#60a5fa', 70), ('cancelled', 'Cancelada', '#71717a', 80)
  ) as s(id, name, color, pos);

-- Em revisão pede uma aprovação e, aprovada, vai para Concluída (o de antes).
update stages set policy = '{"approvals": 1, "approveTo": "done"}' where id = 'in_review';

-- ---------- regras: gatilho + condições ----------
alter table rules drop constraint if exists rules_action_check;
alter table rules add column trigger text not null default 'enter';
alter table rules add column conditions jsonb not null default '{}';
alter table rules add column name text not null default '';

-- Disparos únicos de regras por tempo/limite (não repetir na mesma issue).
create table rule_fires (
  rule_id  uuid not null references rules(id) on delete cascade,
  issue_id uuid not null references issues(id) on delete cascade,
  fired_at timestamptz not null default now(),
  primary key (rule_id, issue_id)
);

-- ---------- issue: responsável humano e aprovações ----------
alter table issues add column assignee_id uuid references users(id) on delete set null;
alter table issues add column stage_entered_at timestamptz not null default now();

create table issue_approvals (
  issue_id   uuid not null references issues(id) on delete cascade,
  stage      text not null,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (issue_id, stage, user_id)
);

-- ---------- entrada de issues por webhook (e-mail encaminhado, formulários…) ----------
alter table workspaces add column intake_token text unique;
alter table workspaces add column intake_stage text not null default 'backlog';

-- ---------- permissões finas ----------
-- issue.update vira: editar texto, mover, comentar, prioridade, labels, agente,
-- repositórios e responsável. Quem tinha issue.update ganha todas; quem fazia
-- merge também aprova.
update roles set permissions = array(select distinct unnest(array_remove(permissions, 'issue.update') ||
    array['issue.edit', 'issue.move', 'issue.comment', 'issue.priority', 'issue.labels', 'issue.agent', 'issue.repos', 'issue.assign']))
  where 'issue.update' = any(permissions);
update roles set permissions = array_append(permissions, 'issue.approve')
  where 'issue.merge' = any(permissions) and not ('issue.approve' = any(permissions));
update roles set permissions = array(select distinct unnest(permissions || array['label.manage', 'workflow.duplicate']))
  where name = 'Administrador';
