-- Menos configuração: o agente sempre roda isolado no worktree (sandbox do CLI),
-- então não há mais "permissão" por agente; e o repositório é só URL, branches
-- e descrição: setup, arquivos de ambiente, instruções e branches protegidas saem.
alter table agents drop column permission;
alter table repos
  drop column protected_branches,
  drop column setup_script,
  drop column env_files,
  drop column instructions;
