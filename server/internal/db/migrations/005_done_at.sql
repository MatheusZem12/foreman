-- When the issue was done: the basis of the "resolved per month" charts.
alter table issues add column done_at timestamptz;
update issues set done_at = updated_at where status = 'done';

create function issues_done_at() returns trigger language plpgsql as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;
  return new;
end $$;

create trigger issues_done_at before insert or update of status on issues
  for each row execute function issues_done_at();

create index issues_done_idx on issues(workspace_id, done_at) where done_at is not null;
