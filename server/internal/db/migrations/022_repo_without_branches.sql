-- A repository is just the URL (plus name and description). The issue starts from the
-- remote's default branch, resolved on the first run; empty = not resolved yet.
-- Existing issues keep the branches they copied from the repository.
alter table repos drop column default_branch, drop column target_branch;
alter table issue_repos alter column base_branch set default '', alter column target_branch set default '';
