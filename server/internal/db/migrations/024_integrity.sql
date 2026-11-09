-- Guarantees that used to depend on a check-then-act in the code, and so failed when two
-- requests arrived together.

-- Only one owner, even if several people race for the first sign-up.
update users set is_owner = false
where is_owner and id <> (select id from users where is_owner order by created_at, id limit 1);
create unique index users_single_owner on users(is_owner) where is_owner;

-- One active run per issue: two at once would write in the same worktree.
update runs r set status = 'cancelled', error = 'Superseded by a newer run of the same issue.', ended_at = now()
where r.status in ('queued', 'running') and exists (
  select 1 from runs o where o.issue_id = r.issue_id and o.status in ('queued', 'running')
    and (o.created_at, o.id) > (r.created_at, r.id));
create unique index runs_one_active on runs(issue_id) where status in ('queued', 'running');

-- An approval is for the code that was reviewed: new commits void it, without losing the
-- history analytics counts.
alter table issue_approvals add column void_at timestamptz;
