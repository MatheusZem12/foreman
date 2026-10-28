-- Uma permissão "ver" por tela. A tela aparece com o "ver" ou com qualquer
-- permissão de criar/editar/excluir dela; com só o "ver", abre em modo leitura.
-- Perfis existentes ganham o "ver" do que já enxergavam (ninguém perde acesso).
update roles set permissions = array(select distinct unnest(permissions || array['analytics.view']));
update roles set permissions = array(select distinct unnest(permissions || array['agent.view']))
  where permissions && array['agent.create', 'agent.update', 'agent.delete'];
update roles set permissions = array(select distinct unnest(permissions || array['skill.view']))
  where permissions && array['skill.create', 'skill.update', 'skill.delete'];
update roles set permissions = array(select distinct unnest(permissions || array['workflow.view']))
  where permissions && array['workflow.manage'];
update roles set permissions = array(select distinct unnest(permissions || array['workspace.view']))
  where permissions && array['repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete', 'label.manage'];
update roles set permissions = array(select distinct unnest(permissions || array['user.view']))
  where permissions && array['user.create', 'user.update', 'user.delete'];
-- Os perfis padrão: o Administrador vê tudo; o Membro vê as telas em modo leitura.
update roles set permissions = array(select distinct unnest(permissions ||
    array['analytics.view', 'workflow.view', 'workspace.view', 'agent.view', 'skill.view', 'user.view']))
  where name in ('Administrador', 'Membro');
