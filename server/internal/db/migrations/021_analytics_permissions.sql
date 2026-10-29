-- Analytics: the workspace's and the overall one, each with "only my numbers" and
-- "everyone" as separate permissions. Before, analytics.view saw everything of every
-- workspace: whoever had it keeps seeing everything.
update roles set permissions = array(select distinct unnest(permissions ||
    array['analytics.team', 'analytics.global', 'analytics.global_team']))
  where 'analytics.view' = any(permissions);
