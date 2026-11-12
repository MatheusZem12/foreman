-- A workspace's name is unique, like its key (ignoring case and surrounding spaces).

-- Workspaces that already repeat a name keep the oldest as is; the others get the key
-- appended ("Shop (SHOP2)"), which is unique, so the index below can be created.
update workspaces w set name = btrim(w.name) || ' (' || w.key || ')'
where exists (
  select 1 from workspaces o
  where lower(btrim(o.name)) = lower(btrim(w.name))
    and (o.created_at, o.id) < (w.created_at, w.id));

create unique index workspaces_name_unique on workspaces(lower(btrim(name)));
