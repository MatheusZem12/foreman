-- Gatilho "Uma regra falhou": qualquer problema numa regra (agente sem
-- repositório, script, merge, PR…) dispara as regras dele. O padrão leva a
-- issue para Bloqueada, como antes, mas agora é uma regra editável.
insert into rules(workspace_id, stage, trigger, action, config, conditions, position)
select id, '', 'rule_failed', 'move', '{"to": "blocked"}', '{}', 7 from workspaces w
where exists (select 1 from stages s where s.workspace_id = w.id and s.id = 'blocked');

create or replace function seed_default_behavior(ws uuid) returns void language sql as $$
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
    -- Qualquer regra que falhar (sem "se falhar, mover para" próprio) bloqueia.
    (ws, '', 'rule_failed', 'move', '{"to": "blocked"}', '{}', 7),
    -- O que conta como resolvida e como cancelada.
    (ws, 'done', 'access', 'close', '{"kind": "done"}', '{}', 0),
    (ws, 'cancelled', 'access', 'close', '{"kind": "cancelled"}', '{}', 0);
$$;
