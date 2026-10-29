-- Less configuration: the agent always runs isolated in the worktree (the CLI's sandbox),
-- so there is no per-agent "permission" anymore; and a repository is just URL, branches
-- and description: setup, environment files, instructions and protected branches go away.
alter table agents drop column permission;
alter table repos
  drop column protected_branches,
  drop column setup_script,
  drop column env_files,
  drop column instructions;
