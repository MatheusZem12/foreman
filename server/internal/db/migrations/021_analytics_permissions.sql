-- Analytics: do workspace e geral, cada um com "só os meus números" e
-- "todo mundo" como permissões separadas. Antes, analytics.view via tudo de
-- todos os workspaces: quem tinha continua vendo tudo.
update roles set permissions = array(select distinct unnest(permissions ||
    array['analytics.team', 'analytics.global', 'analytics.global_team']))
  where 'analytics.view' = any(permissions);
