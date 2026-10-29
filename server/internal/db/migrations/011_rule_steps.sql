-- An agent run requested by a stage rule: the issue stays in the stage while the agent
-- works, and the stage's next rules run afterwards.
alter table runs add column hold_stage boolean not null default false;
