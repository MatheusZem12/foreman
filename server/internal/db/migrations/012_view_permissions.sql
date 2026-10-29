-- One "view" permission per screen. The screen shows with "view" or with any of its
-- create/edit/delete permissions; with "view" alone, it opens read-only.
-- Existing roles get the "view" of what they already saw (nobody loses access).
update roles set permissions = array(select distinct unnest(permissions || array['analytics.view']));
update roles set permissions = array(select distinct unnest(permissions || array['agent.view']))
  where permissions && array['agent.create', 'agent.update', 'agent.delete'];
update roles set permissions = array(select distinct unnest(permissions || array['skill.view']))
  where permissions && array['skill.create', 'skill.update', 'skill.delete'];
update roles set permissions = array(select distinct unnest(permissions || array['workflow.view']))
  where permissions && array['workflow.manage'];
update roles set permissions = array(select distinct unnest(permissions || array['workspace.view']))
  where permissions && array['repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete', 'label.manage'];
update roles set permissions = array(select distinct unnest(permissions || array['user.view']))
  where permissions && array['user.create', 'user.update', 'user.delete'];
-- The default roles: Administrator sees everything; Member sees the screens read-only.
update roles set permissions = array(select distinct unnest(permissions ||
    array['analytics.view', 'workflow.view', 'workspace.view', 'agent.view', 'skill.view', 'user.view']))
  where name in ('Administrator', 'Member');
