-- Histórico de etapas: quando cada issue entrou e saiu de cada etapa, para
-- medir o tempo médio por etapa e o ciclo completo (criação → conclusão).
create table issue_stage_log (
  id           bigserial primary key,
  issue_id     uuid not null references issues(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stage        text not null,
  entered_at   timestamptz not null default now(),
  left_at      timestamptz
);
create index issue_stage_log_issue_idx on issue_stage_log(issue_id) where left_at is null;
create index issue_stage_log_ws_idx on issue_stage_log(workspace_id, left_at);

-- Ponto de partida: a etapa em que cada issue está agora.
insert into issue_stage_log(issue_id, workspace_id, stage, entered_at)
  select id, workspace_id, status, stage_entered_at from issues;
