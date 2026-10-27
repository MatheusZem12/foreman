-- Parâmetros do sistema que o admin edita pela interface (ex.: e-mail de envio).
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Preferência individual: quem não quiser receber e-mail desliga no perfil.
alter table users add column email_notifications boolean not null default true;
