-- A skill can apply to chosen workspaces: every run of their issues gets it, whatever the agent.
alter table skills add column workspace_ids uuid[] not null default '{}';
