-- Repositório é só a URL (mais nome e descrição). A issue parte da branch
-- padrão do remoto, resolvida na primeira execução; vazio = ainda não resolvida.
-- Issues que já existem guardam as branches que copiaram do repositório.
alter table repos drop column default_branch, drop column target_branch;
alter table issue_repos alter column base_branch set default '', alter column target_branch set default '';
