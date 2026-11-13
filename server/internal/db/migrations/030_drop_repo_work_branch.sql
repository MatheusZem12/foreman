-- A repository no longer has a working branch: where an issue works is up to the issue
-- and the skills/scripts that drive it, not the repository.
alter table repos drop column if exists work_branch;
