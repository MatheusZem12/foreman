-- Perfis de acesso: o dono (primeiro cadastro) define quais permissões cada
-- perfil tem; cada usuário recebe um perfil. O dono sempre pode tudo.
create table roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  permissions text[] not null default '{}',
  created_at  timestamptz not null default now()
);
insert into roles(name, permissions) values
  ('Administrador', array['issue.create','issue.update','issue.delete','issue.run','issue.merge',
    'agent.create','agent.update','agent.delete','skill.create','skill.update','skill.delete',
    'workspace.create','workspace.update','workspace.delete','workspace.all',
    'repo.create','repo.update','repo.delete','member.manage',
    'user.create','user.update','user.delete','settings.manage']),
  ('Membro', array['issue.create','issue.update','issue.run','issue.merge']);

alter table users add column is_owner boolean not null default false;
alter table users add column role_id uuid references roles(id) on delete set null;
update users set role_id = (select id from roles where name = case when is_admin then 'Administrador' else 'Membro' end);
update users set is_owner = true where id = (select id from users where is_admin order by created_at limit 1);
alter table users drop column is_admin;

-- Usuário já com o perfil resolvido: o dono recebe '*' (todas).
create view user_view as
  select u.*, coalesce(r.name, '') as role_name,
    case when u.is_owner then array['*'] else coalesce(r.permissions, '{}') end as permissions
  from users u left join roles r on r.id = u.role_id;

-- Uma issue pode envolver vários repositórios do workspace. all_repos = a IA
-- recebe todos e decide em quais mexer; senão, só os escolhidos.
create table issue_repos (
  issue_id      uuid not null references issues(id) on delete cascade,
  repo_id       uuid not null references repos(id) on delete cascade,
  base_branch   text not null,
  target_branch text not null,
  changed       boolean not null default false,  -- a branch da issue tem commits neste repo
  conflict      boolean not null default false,  -- o último merge parou em conflito
  merged_into   text not null default '',
  merged_sha    text not null default '',
  primary key (issue_id, repo_id)
);
insert into issue_repos(issue_id, repo_id, base_branch, target_branch, merged_into)
  select id, repo_id, base_branch, target_branch, merged_into from issues where repo_id is not null;
alter table issues add column all_repos boolean not null default true;
update issues set all_repos = false where repo_id is not null;
alter table issues drop column repo_id, drop column base_branch, drop column target_branch, drop column merged_into;

-- Descrição curta: vai no mapa de repositórios que a IA usa para decidir onde mexer.
alter table repos add column description text not null default '';
