-- Etapa em paralelo: fica ao lado da etapa anterior no fluxo e divide a mesma
-- coluna no quadro (uma embaixo da outra). Ex.: depois de "Prioridade",
-- "Difícil" e "Médio" em paralelo, cada uma recebendo um tipo de issue.
alter table stages add column parallel boolean not null default false;
