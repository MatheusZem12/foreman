-- The stage's policy (who may, locks, requirements, limit, approval, owners) becomes an
-- "access" rule (trigger 'access'), like the stage's other rules. The stage keeps only
-- name, position, color and parallel.
create function pg_temp.who(p jsonb) returns jsonb language sql as $$
  select jsonb_build_object('roles', coalesce(p->'roles', '[]'), 'users', coalesce(p->'users', '[]'))
$$;
create function pg_temp.has_who(p jsonb) returns boolean language sql as $$
  select coalesce(jsonb_array_length(p->'roles'), 0) + coalesce(jsonb_array_length(p->'users'), 0) > 0
$$;

insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'allow_act', pg_temp.who(policy->'act'), 100 from stages where pg_temp.has_who(policy->'act');
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'allow_enter', pg_temp.who(policy->'enter'), 101 from stages where pg_temp.has_who(policy->'enter');
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'read_only', '{}', 102 from stages where coalesce((policy->>'readOnly')::boolean, false);
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'lock_fields', jsonb_build_object('fields', policy->'locked'), 103 from stages where coalesce(jsonb_array_length(policy->'locked'), 0) > 0;
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'require', jsonb_build_object('requires', policy->'requires'), 104 from stages where coalesce(jsonb_array_length(policy->'requires'), 0) > 0;
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'wip', jsonb_build_object('wip', (policy->>'wip')::int), 105 from stages where coalesce((policy->>'wip')::int, 0) > 0;
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'approval',
  pg_temp.who(policy->'approvers') || jsonb_build_object('approvals', (policy->>'approvals')::int, 'to', coalesce(nullif(policy->>'approveTo', ''), 'done')), 106
from stages where coalesce((policy->>'approvals')::int, 0) > 0;
insert into rules(workspace_id, stage, trigger, action, config, position)
select workspace_id, id, 'access', 'responsible', pg_temp.who(policy->'responsible'), 107 from stages where pg_temp.has_who(policy->'responsible');

alter table stages drop column policy;
