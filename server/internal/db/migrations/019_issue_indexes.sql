-- The board loads issues per stage and in pages; each order has an index.
create index if not exists issues_stage_position_idx on issues(workspace_id, status, position, number);
create index if not exists issues_stage_created_idx on issues(workspace_id, status, created_at, number);
create index if not exists issues_stage_updated_idx on issues(workspace_id, status, updated_at, number);
create index if not exists issues_labels_idx on issues using gin(label_ids);
create index if not exists runs_active_idx on runs(issue_id) where status in ('queued', 'running');
