-- Labels get their own screen and separate permissions (view, create, edit, delete) in
-- place of label.manage. Whoever could already, still can.
update roles set permissions = array(select distinct unnest(permissions || array['label.create', 'label.update', 'label.delete']))
  where 'label.manage' = any(permissions);
update roles set permissions = array(select distinct unnest(permissions || array['label.create']))
  where 'issue.labels' = any(permissions);
update roles set permissions = array(select distinct unnest(permissions || array['label.view']))
  where permissions && array['workspace.view', 'label.create', 'label.update', 'label.delete', 'issue.labels'];
update roles set permissions = array_remove(permissions, 'label.manage');
