-- The repository's working branch is back, now picked from the remote's branches (never typed):
-- its issues start from it and merge into it. '' = not chosen yet (falls back to the remote's default).
alter table repos add column if not exists work_branch text not null default '';
