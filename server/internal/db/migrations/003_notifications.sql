-- System parameters the admin edits through the interface (e.g. the sender e-mail).
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Individual preference: whoever doesn't want e-mail turns it off in their profile.
alter table users add column email_notifications boolean not null default true;
