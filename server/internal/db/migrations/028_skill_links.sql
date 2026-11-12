-- Skills are linked by agent, by workspace and by label (any match sends the skill).
alter table skills add column label_ids uuid[] not null default '{}';

-- "Every issue" becomes "every workspace that exists".
update skills set workspace_ids = (select coalesce(array_agg(id), '{}') from workspaces), always = false where always;

-- Agent instructions move to a skill linked to that agent (the agent form no longer has them).
with moved as (
  insert into skills(slug, name, description, content)
  select left(regexp_replace(lower(a.name), '[^a-z0-9]+', '-', 'g'), 30) || '-instructions-' || left(a.id::text, 8),
         a.name || ' instructions', 'Role, style and rules of the ' || a.name || ' agent. Always read it.', a.instructions
  from agents a where btrim(a.instructions) <> ''
  returning id, name
)
update agents a set skill_ids = a.skill_ids || m.id, instructions = ''
from moved m where m.name = a.name || ' instructions';
