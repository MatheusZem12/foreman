-- Sem entrada de issues por webhook: integrações externas virão por uma API
-- com token próprio, quando fizer sentido.
alter table workspaces drop column intake_token, drop column intake_stage;
