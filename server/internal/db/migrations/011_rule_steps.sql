-- Execução de agente pedida por uma regra de etapa: a issue fica na etapa
-- enquanto o agente trabalha, e as regras seguintes da etapa rodam depois.
alter table runs add column hold_stage boolean not null default false;
