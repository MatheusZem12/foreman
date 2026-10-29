-- The "A rule failed" trigger: any problem in a rule (agent without a repository,
-- script, merge, PR…) fires its rules. The default takes the issue to Blocked, as
-- before, but now it is an editable rule.
insert into rules(workspace_id, stage, trigger, action, config, conditions, position)
select id, '', 'rule_failed', 'move', '{"to": "blocked"}', '{}', 7 from workspaces w
where exists (select 1 from stages s where s.workspace_id = w.id and s.id = 'blocked');

create or replace function seed_default_behavior(ws uuid) returns void language sql as $$
  insert into rules(workspace_id, stage, trigger, action, config, conditions, position) values
    -- To do: with an agent, it starts right away (without one it stays a manual task).
    (ws, 'todo', 'enter', 'run_agent', '{}', '{}', -1),
    -- Every request to the agent (board, comment, reply) goes to In progress.
    (ws, '', 'run_started', 'move', '{"to": "in_progress"}', '{}', 0),
    -- The AI's outcome decides the next stage.
    (ws, '', 'run_finished', 'move', '{"to": "in_review"}', '{"outcomes": ["done"], "stages": ["in_progress"]}', 1),
    (ws, '', 'run_finished', 'move', '{"to": "waiting"}', '{"outcomes": ["waiting", "incomplete"], "stages": ["in_progress"]}', 2),
    (ws, '', 'run_finished', 'move', '{"to": "blocked"}', '{"outcomes": ["failed"], "stages": ["in_progress"]}', 3),
    (ws, '', 'run_finished', 'move', '{"to": "backlog"}', '{"outcomes": ["cancelled"], "stages": ["in_progress"]}', 4),
    -- Going back to Backlog or cancelling stops the agent.
    (ws, 'backlog', 'enter', 'stop_agent', '{}', '{}', -1),
    (ws, 'cancelled', 'enter', 'stop_agent', '{}', '{}', -1),
    -- Merge feito conclui; conflito bloqueia.
    (ws, '', 'merged', 'move', '{"to": "done"}', '{}', 5),
    (ws, '', 'merge_conflict', 'move', '{"to": "blocked"}', '{}', 6),
    -- Any rule that fails (without its own "if it fails, move to") blocks.
    (ws, '', 'rule_failed', 'move', '{"to": "blocked"}', '{}', 7),
    -- What counts as resolved and as cancelled.
    (ws, 'done', 'access', 'close', '{"kind": "done"}', '{}', 0),
    (ws, 'cancelled', 'access', 'close', '{"kind": "cancelled"}', '{}', 0);
$$;
