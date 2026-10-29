-- No stage has built-in behaviour: what used to be fixed in the code (a request to the
-- agent goes to In progress, the AI's outcome decides the next stage, To do runs the
-- agent, merge leads to Done…) becomes ordinary rules, created by default in every
-- workspace and editable like the others.
-- Every stage can be renamed or removed.

alter table stages drop column system;

-- "Closed" comes from the stage's "Close the issue" access rule (done or cancelled);
-- the server keeps closed and done_at when the stage changes.
drop trigger issues_done_at on issues;
drop function issues_done_at();
alter table issues add column closed text not null default '';
update issues set closed = 'done' where status = 'done';
update issues set closed = 'cancelled' where status = 'cancelled';

-- "Run agent" steps that already existed in a stage waited for the agent to finish.
update rules set config = config || '{"wait": true}'
where action = 'run_agent' and trigger in ('enter', 'leave', 'stale');

-- What the default workflow does on its own. Also used by seed_workflow.
create function seed_default_behavior(ws uuid) returns void language sql as $$
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
    -- What counts as resolved and as cancelled.
    (ws, 'done', 'access', 'close', '{"kind": "done"}', '{}', 0),
    (ws, 'cancelled', 'access', 'close', '{"kind": "cancelled"}', '{}', 0);
$$;

-- The workflow every workspace is born with: stages and rules, all editable.
create function seed_workflow(ws uuid) returns void language sql as $$
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

-- Existing workspaces get the rules of the behaviour that used to be fixed.
select seed_default_behavior(id) from workspaces;
