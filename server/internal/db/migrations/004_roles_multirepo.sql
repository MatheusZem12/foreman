-- Access roles: the owner (first sign-up) defines which permissions each role has;
-- each user gets a role. The owner can always do everything.
create table roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  permissions text[] not null default '{}',
  created_at  timestamptz not null default now()
);
insert into roles(name, permissions) values
  ('Administrator', array['issue.create','issue.update','issue.delete','issue.run','issue.merge',
    'agent.create','agent.update','agent.delete','skill.create','skill.update','skill.delete',
    'workspace.create','workspace.update','workspace.delete','workspace.all',
    'repo.create','repo.update','repo.delete','member.manage',
    'user.create','user.update','user.delete','settings.manage']),
  ('Member', array['issue.create','issue.update','issue.run','issue.merge']);

alter table users add column is_owner boolean not null default false;
alter table users add column role_id uuid references roles(id) on delete set null;
update users set role_id = (select id from roles where name = case when is_admin then 'Administrator' else 'Member' end);
update users set is_owner = true where id = (select id from users where is_admin order by created_at limit 1);
alter table users drop column is_admin;

-- A user with the role already resolved: the owner gets '*' (all).
create view user_view as
  select u.*, coalesce(r.name, '') as role_name,
    case when u.is_owner then array['*'] else coalesce(r.permissions, '{}') end as permissions
  from users u left join roles r on r.id = u.role_id;

-- An issue may involve several of the workspace's repositories. all_repos = the AI
-- gets all of them and decides which to touch; otherwise, only the chosen ones.
create table issue_repos (
  issue_id      uuid not null references issues(id) on delete cascade,
  repo_id       uuid not null references repos(id) on delete cascade,
  base_branch   text not null,
  target_branch text not null,
  changed       boolean not null default false,  -- the issue branch has commits in this repo
  conflict      boolean not null default false,  -- the last merge stopped in conflict
  merged_into   text not null default '',
  merged_sha    text not null default '',
  primary key (issue_id, repo_id)
);
insert into issue_repos(issue_id, repo_id, base_branch, target_branch, merged_into)
  select id, repo_id, base_branch, target_branch, merged_into from issues where repo_id is not null;
alter table issues add column all_repos boolean not null default true;
update issues set all_repos = false where repo_id is not null;
alter table issues drop column repo_id, drop column base_branch, drop column target_branch, drop column merged_into;

-- Short description: it goes into the repository map the AI uses to decide where to work.
alter table repos add column description text not null default '';
