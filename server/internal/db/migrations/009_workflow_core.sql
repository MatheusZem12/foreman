-- The workflow core: each workspace has all its stages (the system ones too, so they
-- can be reordered, renamed and configured), with policies of who can do what in each;
-- rules with several triggers and conditions; a human assignee per issue; approvals;
-- issue intake by webhook; and fine-grained permissions in place of the old
-- issue.update.

-- ---------- stages: one row per stage per workspace ----------
alter table stages drop constraint stages_pkey;
alter table stages alter column id drop default;
alter table stages alter column id type text using id::text;
alter table stages add column system boolean not null default false;
-- policy: who brings issues here, who works on them here, locked fields, requirements,
-- issue limit, approvals and owners (see store.StagePolicy).
alter table stages add column policy jsonb not null default '{}';
alter table stages add primary key (workspace_id, id);

insert into stages(workspace_id, id, name, color, position, system)
  select w.id, s.id, s.name, s.color, s.pos, true
  from workspaces w cross join (values
    ('backlog', 'Backlog', '#8b8b94', 10), ('todo', 'To do', '#d4d4d8', 20),
    ('in_progress', 'In progress', '#f5b83d', 30), ('waiting', 'Waiting for you', '#fb923c', 40),
    ('in_review', 'In review', '#4ade80', 50), ('blocked', 'Blocked', '#f87171', 60),
    ('done', 'Done', '#60a5fa', 70), ('cancelled', 'Cancelled', '#71717a', 80)
  ) as s(id, name, color, pos);

-- In review asks for one approval and, once approved, goes to Done (as before).
update stages set policy = '{"approvals": 1, "approveTo": "done"}' where id = 'in_review';

-- ---------- rules: trigger + conditions ----------
alter table rules drop constraint if exists rules_action_check;
alter table rules add column trigger text not null default 'enter';
alter table rules add column conditions jsonb not null default '{}';
alter table rules add column name text not null default '';

-- Single firings of time/limit rules (don't repeat on the same issue).
create table rule_fires (
  rule_id  uuid not null references rules(id) on delete cascade,
  issue_id uuid not null references issues(id) on delete cascade,
  fired_at timestamptz not null default now(),
  primary key (rule_id, issue_id)
);

-- ---------- issue: human assignee and approvals ----------
alter table issues add column assignee_id uuid references users(id) on delete set null;
alter table issues add column stage_entered_at timestamptz not null default now();

create table issue_approvals (
  issue_id   uuid not null references issues(id) on delete cascade,
  stage      text not null,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (issue_id, stage, user_id)
);

-- ---------- issue intake by webhook (forwarded e-mail, forms…) ----------
alter table workspaces add column intake_token text unique;
alter table workspaces add column intake_stage text not null default 'backlog';

-- ---------- fine-grained permissions ----------
-- issue.update becomes: edit text, move, comment, priority, labels, agent, repositories
-- and assignee. Whoever had issue.update gets all of them; whoever could merge also
-- approves.
update roles set permissions = array(select distinct unnest(array_remove(permissions, 'issue.update') ||
    array['issue.edit', 'issue.move', 'issue.comment', 'issue.priority', 'issue.labels', 'issue.agent', 'issue.repos', 'issue.assign']))
  where 'issue.update' = any(permissions);
update roles set permissions = array_append(permissions, 'issue.approve')
  where 'issue.merge' = any(permissions) and not ('issue.approve' = any(permissions));
update roles set permissions = array(select distinct unnest(permissions || array['label.manage', 'workflow.duplicate']))
  where name = 'Administrator';
