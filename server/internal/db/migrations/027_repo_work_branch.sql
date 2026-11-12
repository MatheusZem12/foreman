-- Optional: the branch a repository's issues start from and merge into. Empty = the
-- remote's default branch (as before).
alter table repos add column work_branch text not null default '';
