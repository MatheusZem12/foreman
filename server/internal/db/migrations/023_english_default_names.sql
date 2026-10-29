-- The default workflow is born in English. Stages that still carry the Portuguese default
-- name (nobody renamed them) get the English one; the interface translates default names
-- back for whoever uses it in Portuguese. Renamed stages are left alone.
update stages set name = v.en
  from (values ('todo', 'A fazer', 'To do'), ('in_progress', 'Em andamento', 'In progress'),
               ('waiting', 'Aguardando você', 'Waiting for you'), ('in_review', 'Em revisão', 'In review'),
               ('blocked', 'Bloqueada', 'Blocked'), ('done', 'Concluída', 'Done'),
               ('cancelled', 'Cancelada', 'Cancelled')) as v(id, pt, en)
 where stages.id = v.id and stages.name = v.pt;

-- The workflow every workspace is born with: stages and rules, all editable.
create or replace function seed_workflow(ws uuid) returns void language sql as $$
  insert into stages(workspace_id, id, name, color, position) values
    (ws, 'backlog', 'Backlog', '#8b8b94', 10),
    (ws, 'todo', 'To do', '#d4d4d8', 20),
    (ws, 'in_progress', 'In progress', '#f5b83d', 30),
    (ws, 'waiting', 'Waiting for you', '#fb923c', 40),
    (ws, 'in_review', 'In review', '#4ade80', 50),
    (ws, 'blocked', 'Blocked', '#f87171', 60),
    (ws, 'done', 'Done', '#60a5fa', 70),
    (ws, 'cancelled', 'Cancelled', '#71717a', 80)
  on conflict do nothing;
  insert into rules(workspace_id, stage, trigger, action, config, position) values
    (ws, 'done', 'enter', 'merge', '{}', 0),
    (ws, 'waiting', 'enter', 'notify', '{"to": "requester"}', 0),
    (ws, 'in_review', 'access', 'approval', '{"approvals": 1, "to": "done"}', 0);
  select seed_default_behavior(ws);
$$;

-- The default roles, under the same rule: renamed ones are left alone.
update roles set name = 'Administrator' where name = 'Administrador';
update roles set name = 'Member' where name = 'Membro';
