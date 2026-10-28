-- Preferências de visualização de cada pessoa (ex.: a arrumação do quadro de
-- um workspace). Só aparência: nada aqui muda regra, etapa ou permissão.
create table user_prefs (
  user_id    uuid not null references users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
