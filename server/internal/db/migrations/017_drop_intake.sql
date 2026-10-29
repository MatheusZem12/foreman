-- No issue intake by webhook: external integrations will come through an API with its
-- own token, when it makes sense.
alter table workspaces drop column intake_token, drop column intake_stage;
