-- Nenhuma etapa tem comportamento embutido: o que antes era fixo no código
-- (pedido ao agente vai para Em andamento, resultado da IA decide a próxima
-- etapa, A fazer roda o agente, merge leva para Concluída…) vira regras
-- comuns, criadas como padrão em todo workspace e editáveis como as demais.
-- Todas as etapas podem ser renomeadas ou removidas.

alter table stages drop column system;

-- "Encerrada" vem da regra de acesso "Encerrar a issue" da etapa (concluída
-- ou cancelada); o servidor mantém closed e done_at ao mudar de etapa.
drop trigger issues_done_at on issues;
drop function issues_done_at();
alter table issues add column closed text not null default '';
update issues set closed = 'done' where status = 'done';
update issues set closed = 'cancelled' where status = 'cancelled';

-- Passos "rodar agente" que já existiam numa etapa esperavam o agente terminar.
update rules set config = config || '{"wait": true}'
where action = 'run_agent' and trigger in ('enter', 'leave', 'stale');

-- O que o fluxo padrão faz sozinho. Também usado por seed_workflow.
create function seed_default_behavior(ws uuid) returns void language sql as $$
  insert into rules(workspace_id, stage, trigger, action, config, conditions, position) values
    -- A fazer: com agente, já começa (sem agente fica como tarefa manual).
    (ws, 'todo', 'enter', 'run_agent', '{}', '{}', -1),
    -- Todo pedido ao agente (quadro, comentário, resposta) vai para Em andamento.
    (ws, '', 'run_started', 'move', '{"to": "in_progress"}', '{}', 0),
    -- O resultado da IA decide a próxima etapa.
    (ws, '', 'run_finished', 'move', '{"to": "in_review"}', '{"outcomes": ["done"], "stages": ["in_progress"]}', 1),
    (ws, '', 'run_finished', 'move', '{"to": "waiting"}', '{"outcomes": ["waiting", "incomplete"], "stages": ["in_progress"]}', 2),
    (ws, '', 'run_finished', 'move', '{"to": "blocked"}', '{"outcomes": ["failed"], "stages": ["in_progress"]}', 3),
    (ws, '', 'run_finished', 'move', '{"to": "backlog"}', '{"outcomes": ["cancelled"], "stages": ["in_progress"]}', 4),
    -- Voltar ao Backlog ou cancelar para o agente.
    (ws, 'backlog', 'enter', 'stop_agent', '{}', '{}', -1),
    (ws, 'cancelled', 'enter', 'stop_agent', '{}', '{}', -1),
    -- Merge feito conclui; conflito bloqueia.
    (ws, '', 'merged', 'move', '{"to": "done"}', '{}', 5),
    (ws, '', 'merge_conflict', 'move', '{"to": "blocked"}', '{}', 6),
    -- O que conta como resolvida e como cancelada.
    (ws, 'done', 'access', 'close', '{"kind": "done"}', '{}', 0),
    (ws, 'cancelled', 'access', 'close', '{"kind": "cancelled"}', '{}', 0);
$$;

-- Fluxo com que todo workspace nasce: etapas e regras, tudo editável.
create function seed_workflow(ws uuid) returns void language sql as $$
  insert into stages(workspace_id, id, name, color, position) values
    (ws, 'backlog', 'Backlog', '#8b8b94', 10),
    (ws, 'todo', 'A fazer', '#d4d4d8', 20),
    (ws, 'in_progress', 'Em andamento', '#f5b83d', 30),
    (ws, 'waiting', 'Aguardando você', '#fb923c', 40),
    (ws, 'in_review', 'Em revisão', '#4ade80', 50),
    (ws, 'blocked', 'Bloqueada', '#f87171', 60),
    (ws, 'done', 'Concluída', '#60a5fa', 70),
    (ws, 'cancelled', 'Cancelada', '#71717a', 80)
  on conflict do nothing;
  insert into rules(workspace_id, stage, trigger, action, config, position) values
    (ws, 'done', 'enter', 'merge', '{}', 0),
    (ws, 'waiting', 'enter', 'notify', '{"to": "requester"}', 0),
    (ws, 'in_review', 'access', 'approval', '{"approvals": 1, "to": "done"}', 0);
  select seed_default_behavior(ws);
$$;

-- Workspaces que já existem ganham as regras do comportamento que antes era fixo.
select seed_default_behavior(id) from workspaces;
