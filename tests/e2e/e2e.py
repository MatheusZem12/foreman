import json, time, urllib.request, http.cookiejar, subprocess, os
B = 'http://127.0.0.1:18700/api'
REM = os.path.dirname(os.path.abspath(__file__)) + '/remote'
def session():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(m, p, body=None):
        req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
        try:
            r = op.open(req); t = r.read(); return 200, (json.loads(t) if t else None)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')
    return call
fails = 0
def check(cond, label):
    global fails
    print(('OK   ' if cond else 'ERRO ') + label); fails += 0 if cond else 1
def ok(res):
    st, body = res
    if st != 200: raise SystemExit(f'FALHA {st} {body}')
    return body
def git(repo, *args):
    return subprocess.run(['git', f'--git-dir={REM}/{repo}.git', *args], capture_output=True, text=True).stdout.strip()
def remote_has(repo, branch): return git(repo, 'rev-parse', '--verify', '-q', branch) != ''
def show(repo, path, ref='main'): return git(repo, 'show', f'{ref}:{path}')

own = session()
st, me = own('POST', '/setup', {'name': 'Dono', 'email': 'dono@x.com', 'password': 'senha1234'})
check(me['isOwner'] and me['permissions'] == ['*'] and me['roleName'] == 'Administrador', 'primeiro cadastro = dono com tudo')

# ---------- perfis ----------
roles = {r['name']: r for r in ok(own('GET', '/roles'))}
check(set(roles) == {'Administrador', 'Membro'}, 'perfis padrão: Administrador e Membro')
check(own('POST', '/roles', {'name': 'X', 'permissions': ['voar']})[0] == 400, 'permissão desconhecida é recusada')
leitor = ok(own('POST', '/roles', {'name': 'Leitor', 'permissions': []}))
ws = ok(own('POST', '/workspaces', {'name': 'Loja', 'key': 'LOJA'}))
ws2 = ok(own('POST', '/workspaces', {'name': 'Outro', 'key': 'OUT'}))
mk = lambda n, role, wss: ok(own('POST', '/users', {'name': n, 'email': f'{n}@x.com', 'password': 'senha1234', 'roleId': role, 'workspaceIds': wss}))
ana = mk('ana', roles['Membro']['id'], [ws['id']]); bob = mk('bob', leitor['id'], [ws['id']]); carlos = mk('carlos', roles['Administrador']['id'], [])
def login(n):
    s = session(); ok(s('POST', '/login', {'email': f'{n}@x.com', 'password': 'senha1234'})); return s
A, Bb, C = login('ana'), login('bob'), login('carlos')
check(ok(A('GET', '/me'))['roleName'] == 'Membro', 'usuário criado com o perfil escolhido')
check([w['key'] for w in ok(A('GET', '/workspaces'))] == ['LOJA'] and len(ok(C('GET', '/workspaces'))) == 2, 'Membro vê só o vinculado; Administrador vê todos')
check(C('POST', '/roles', {'name': 'Y', 'permissions': []})[0] == 403, 'só o dono cria perfis (Administrador não)')
check(C('GET', '/roles')[0] == 200, 'Administrador lê perfis para atribuir')
check(C('PATCH', f'/users/{me["id"]}', {'name': 'hack'})[0] == 403 and C('DELETE', f'/users/{me["id"]}')[0] == 400, 'ninguém edita nem remove o dono')
check(Bb('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x'})[0] == 403, 'Leitor não cria issue')
check(A('POST', '/agents', {'name': 'x'})[0] == 403 and A('POST', '/skills', {'name': 'x'})[0] == 403, 'Membro não cria agente nem skill')
check(A('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'x'})[0] == 403, 'Membro não cadastra repositório')
st, i0 = A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'da ana'})
check(st == 200, 'Membro cria issue')
check(A('DELETE', f'/issues/{i0["issue"]["id"]}')[0] == 403, 'Membro não exclui issue (sem issue.delete)')
ok(own('PUT', f'/roles/{roles["Membro"]["id"]}', {'name': 'Membro', 'permissions': roles['Membro']['permissions'] + ['issue.delete']}))
check(A('DELETE', f'/issues/{i0["issue"]["id"]}')[0] == 200, 'dono libera issue.delete no perfil e vale na hora')
check(own('DELETE', f'/roles/{leitor["id"]}')[0] == 400, 'perfil em uso não pode ser excluído')
check(Bb('GET', f'/workspaces/{ws["id"]}/issues')[0] == 200 and Bb('GET', f'/workspaces/{ws2["id"]}/issues')[0] == 404, 'Leitor vê o workspace dele e 404 no outro')
ok(own('PATCH', f'/users/{bob["id"]}', {'roleId': roles['Membro']['id']}))
check(Bb('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'agora pode'})[0] == 200, 'trocar o perfil do usuário muda as permissões')

# ---------- repositórios ----------
st, r = C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/nao-existe.git'})
check(st == 400 and 'não é um repositório git' in r['error'], 'URL que não é repo git é recusada: ' + r.get('error', '')[:70])
desc = {'api': 'API REST (pedidos e pagamentos)', 'web': 'Front-end React da loja', 'docs': 'Documentação'}
repos = {n: ok(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': f'file:///remote/{n}.git', 'defaultBranch': 'main', 'description': desc[n]})) for n in ['api', 'web', 'docs']}
check(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/api.git', 'name': 'API'})[0] == 400, 'nome de repositório repetido é recusado')
ag = ok(C('POST', '/agents', {'name': 'Fake', 'runtime': 'claude'}))

def wait(s, iid, states, t=60):
    for _ in range(t * 4):
        d = ok(s('GET', f'/issues/{iid}'))
        if d['issue']['status'] in states and not d['issue']['activeRun']: return d
        time.sleep(0.25)
    raise SystemExit(f'timeout: {d["issue"]["status"]} {d["runs"][-1:]}')
def rmap(issue): return {r['name']: r for r in issue['repos']}

# ---------- issue em todos os repositórios: a IA mexe só na api ----------
I = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Desconto no pedido', 'description': 'mexer na api', 'status': 'todo', 'agentId': ag['id']}))['issue']
check(I['allRepos'] and sorted(rmap(I)) == ['api', 'docs', 'web'], 'issue nova recebe todos os repositórios do workspace')
d = wait(A, I['id'], ['in_review', 'blocked'])
rm = rmap(d['issue'])
check(d['issue']['status'] == 'in_review', f'execução terminou em revisão ({d["runs"][-1]["error"]})')
check(rm['api']['changed'] and not rm['web']['changed'] and not rm['docs']['changed'], 'só a api ficou marcada como alterada')
br = I['branch']
check(remote_has('api', br) and not remote_has('web', br) and not remote_has('docs', br), 'branch publicada só no repositório alterado')
evs = ok(A('GET', f'/runs/{d["runs"][-1]["id"]}/events'))
prompt = next(e['body'] for e in evs if e['kind'] == 'prompt')
check('`api/` — **api**: API REST (pedidos e pagamentos)' in prompt and 'mexa só neles' in prompt, 'prompt traz o mapa de repositórios com descrição')
check(d['runs'][-1]['commitSha'].startswith('api '), 'commit registrado por repositório: ' + d['runs'][-1]['commitSha'])

# ajuste: agora mexe no web também
ok(A('POST', f'/issues/{I["id"]}/comments', {'body': 'ajusta o front', 'sendToAgent': True}))
d = wait(A, I['id'], ['in_review', 'blocked'])
rm = rmap(d['issue'])
check(rm['api']['changed'] and rm['web']['changed'], 'ajuste por comentário alterou o web, api continua')
diff = ok(A('GET', f'/issues/{I["id"]}/diff'))
check(sorted(x['name'] for x in diff) == ['api', 'web'], 'diff separado por repositório (só os alterados)')
check(all('permission' not in a for a in ok(A('GET', '/agents'))) and all('setupScript' not in x for x in ok(A('GET', f'/workspaces/{ws["id"]}/repos'))), 'sem permissão por agente nem setup/env/protegidas no repositório')
res = ok(A('POST', f'/issues/{I["id"]}/merge', {}))
check(not res['conflict'] and sorted(r['name'] for r in res['repos']) == ['api', 'web'], 'merge feito nos dois repositórios alterados')
check('mudanca api' in show('api', 'main.txt') and 'ajuste web' in show('web', 'main.txt') and show('docs', 'main.txt') == 'docs v1', 'main da api e do web receberam; docs intocado')
d = ok(A('GET', f'/issues/{I["id"]}'))
check(d['issue']['status'] == 'done' and not remote_has('api', br) and not remote_has('web', br), 'issue concluída e branches da issue removidas')

# ---------- escopo escolhido: só web ----------
J = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Só front', 'description': 'SO_WEB', 'status': 'todo', 'agentId': ag['id'], 'repoIds': [repos['web']['id']]}))['issue']
check(not J['allRepos'] and list(rmap(J)) == ['web'], 'issue com escopo escolhido recebe só o web')
d = wait(A, J['id'], ['in_review', 'blocked'])
evs = ok(A('GET', f'/runs/{d["runs"][-1]["id"]}/events'))
prompt = next(e['body'] for e in evs if e['kind'] == 'prompt')
check('git worktree isolado' in prompt and 'repositório **web**' in prompt and rmap(d['issue'])['web']['changed'], 'com um repositório só, o agente trabalha direto nele')

# ---------- conflito entre issues: nada é publicado pela metade ----------
P = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'P', 'description': 'CONFLITO_P', 'status': 'todo', 'agentId': ag['id']}))['issue']
Q = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Q', 'description': 'CONFLITO_Q', 'status': 'todo', 'agentId': ag['id']}))['issue']
wait(A, P['id'], ['in_review']); dq = wait(A, Q['id'], ['in_review'])
check(sorted(n for n, r in rmap(dq['issue']).items() if r['changed']) == ['api', 'web'], 'Q alterou api e web')
ok(A('POST', f'/issues/{P["id"]}/merge', {}))
web_before = git('web', 'rev-parse', 'main')
res = ok(A('POST', f'/issues/{Q["id"]}/merge', {}))
check(res['conflict'] and [r['name'] for r in res['repos'] if r.get('conflict')] == ['api'], 'merge de Q: conflito detectado na api')
check(git('web', 'rev-parse', 'main') == web_before and not show('web', 'q.txt'), 'conflito na api: o web também não foi publicado (tudo ou nada)')
dq = ok(A('GET', f'/issues/{Q["id"]}'))
check(dq['issue']['status'] == 'blocked' and rmap(dq['issue'])['api']['conflict'], 'issue bloqueada com o repo em conflito marcado')
ok(A('POST', f'/issues/{Q["id"]}/run', {'kind': 'conflict'}))
dq = wait(A, Q['id'], ['in_review', 'blocked'])
check(dq['issue']['status'] == 'in_review' and not rmap(dq['issue'])['api']['conflict'], f'IA resolveu o conflito ({dq["runs"][-1]["error"]})')
res = ok(A('POST', f'/issues/{Q["id"]}/merge', {}))
check(not res['conflict'] and show('api', 'conf.txt') == 'resolvido' and show('web', 'q.txt') == 'arquivo do Q', 'merge depois da resolução publica api e web')

# ---------- repositório novo entra nas issues abertas em "todos" ----------
K = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Aberta', 'status': 'backlog'}))['issue']
subprocess.run(['git', 'clone', '-q', '--bare', f'{REM}/docs.git', f'{REM}/mobile.git'])
ok(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/mobile.git', 'description': 'App mobile'}))
check('mobile' in rmap(ok(A('GET', f'/issues/{K["id"]}'))['issue']), 'repositório novo entra nas issues abertas em "todos"')
st, k2 = A('PUT', f'/issues/{K["id"]}/repos', {'all': False, 'repos': [{'repoId': repos['api']['id'], 'targetBranch': 'main'}]})
check(st == 200 and list(rmap(k2)) == ['api'] and not k2['allRepos'], 'trocar o escopo da issue para só a api')
check(Bb('GET', '/git')[0] == 403 and C('GET', '/git')[0] == 200, 'status do git só para quem configura')
# ---------- fluxo: direcionamento, resultado declarado, aprovação ----------
W = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Cor do botão', 'description': 'PRECISA_DECISAO', 'status': 'todo', 'agentId': ag['id'], 'repoIds': [repos['api']['id']]}))['issue']
# o motor de regras roda em paralelo: "agente começou → Em andamento" leva um instante
seen = set()
for _ in range(40):
    seen.add(ok(A('GET', f'/issues/{W["id"]}'))['issue']['status'])
    if seen & {'in_progress', 'waiting'}: break
    time.sleep(0.1)
check('in_progress' in seen or 'waiting' in seen, 'pedido novo vai para Em andamento (regra "agente começou")')
d = wait(A, W['id'], ['waiting', 'in_review', 'blocked'])
check(d['issue']['status'] == 'waiting' and d['runs'][-1]['outcome'] == 'waiting' and d['runs'][-1]['outcomeNote'] == 'azul ou verde?', 'IA declara "aguardando" e a issue vai para Aguardando você')
time.sleep(1.5)
coms = [c['body'] for c in ok(A('GET', f'/issues/{W["id"]}'))['comments']]
check(any('A IA precisa de você' in c and 'azul ou verde?' in c for c in coms), 'a pergunta da IA vira comentário na issue')
check(not any('Regra **Notificar**' in c for c in coms), 'com e-mail desligado, a regra de notificar não polui a issue')
ok(A('POST', f'/issues/{W["id"]}/comments', {'body': 'azul', 'sendToAgent': True}))
seen = set()
for _ in range(40):
    seen.add(ok(A('GET', f'/issues/{W["id"]}'))['issue']['status'])
    if seen & {'in_progress', 'in_review'}: break
    time.sleep(0.1)
check(seen & {'in_progress', 'in_review'}, 'resposta ao agente volta para Em andamento')
d = wait(A, W['id'], ['in_review', 'waiting', 'blocked'])
check(d['issue']['status'] == 'in_review' and d['runs'][-1]['outcome'] == 'done', 'IA declara "concluido" e vai para Em revisão')
check(d['caps']['approve'] and d['caps']['approvals'] == 1, 'a issue diz que a pessoa pode aprovar')
check(A('POST', f'/issues/{K["id"]}/approve')[0] == 400, 'aprovar só vale em etapa com aprovação')
ok(A('POST', f'/issues/{W["id"]}/approve'))
for _ in range(40):
    d = ok(A('GET', f'/issues/{W["id"]}'))
    if rmap(d['issue'])['api']['mergedInto']: break
    time.sleep(0.25)
check(d['issue']['status'] == 'done' and rmap(d['issue'])['api']['mergedInto'] == 'main', 'aprovar leva a Concluída e a regra padrão faz o merge')

# ---------- etapas e regras personalizadas ----------
check(A('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'QA'})[0] == 403, 'Membro não configura o fluxo')
qa = ok(C('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'QA', 'color': '#22d3ee', 'after': 'in_review'}))
names = [x['name'] for x in ok(A('GET', f'/workspaces/{ws["id"]}/stages'))]
check(names.index('QA') == names.index('Em revisão') + 1, 'etapa nova entra depois da escolhida')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': qa['id'], 'action': 'move', 'config': {'to': qa['id']}})[0] == 400, 'regra que move para a própria etapa é recusada')
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': qa['id'], 'action': 'script', 'config': {'script': 'echo "qa de $MULTICA_ISSUE vindo de $MULTICA_FROM"'}}))
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': qa['id'], 'action': 'move', 'config': {'to': 'backlog'}}))
X = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Fluxo', 'status': 'in_review'}))['issue']
check(A('PATCH', f'/issues/{X["id"]}', {'status': 'nao-existe'})[0] == 400, 'etapa desconhecida é recusada')
ok(A('PATCH', f'/issues/{X["id"]}', {'status': qa['id']}))
for _ in range(40):
    d = ok(A('GET', f'/issues/{X["id"]}'))
    if d['issue']['status'] == 'backlog': break
    time.sleep(0.25)
coms = [c['body'] for c in d['comments']]
check(any(f'qa de LOJA-{X["number"]} vindo de in_review' in c for c in coms), 'regra de script roda com as variáveis MULTICA_*')
check(d['issue']['status'] == 'backlog' and any('movida para Backlog' in c for c in coms), 'regra de mover encaminha para a próxima etapa')
loop = ok(C('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'Loop', 'after': 'backlog'}))
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': loop['id'], 'action': 'move', 'config': {'to': 'blocked'}}))
r_b = ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': 'blocked', 'action': 'move', 'config': {'to': loop['id']}}))
ok(A('PATCH', f'/issues/{X["id"]}', {'status': loop['id']}))
time.sleep(4)
coms = [c['body'] for c in ok(A('GET', f'/issues/{X["id"]}'))['comments']]
check(any('loop' in c for c in coms), 'regras em loop param sozinhas')
ok(C('DELETE', f'/rules/{r_b["id"]}'))
ok(C('DELETE', f'/workspaces/{ws["id"]}/stages/{qa["id"]}'))
ok(C('DELETE', f'/workspaces/{ws["id"]}/stages/{loop["id"]}'))
check('QA' not in [x['name'] for x in ok(A('GET', f'/workspaces/{ws["id"]}/stages'))], 'etapa personalizada pode ser removida')

# ---------- empresa: mesmo perfil de permissões, papéis diferentes por etapa ----------
base = ['issue.create', 'issue.edit', 'issue.move', 'issue.comment']
est_role = ok(own('POST', '/roles', {'name': 'Estagiário', 'permissions': base}))
jun_role = ok(own('POST', '/roles', {'name': 'Júnior', 'permissions': base}))
est = mk('est', est_role['id'], [ws['id']]); jun = mk('jun', jun_role['id'], [ws['id']])
zed = mk('zed', roles['Membro']['id'], [ws2['id']])  # só tem acesso ao outro workspace
E_, J_ = login('est'), login('jun')
# A etapa é só nome e posição; quem pode, travas e aprovação são regras de acesso.
def stage_with(name, after, access, w=None):
    w = w or ws
    s = ok(C('POST', f'/workspaces/{w["id"]}/stages', {'name': name, 'after': after}))
    for action, cfg in access:
        ok(C('POST', f'/workspaces/{w["id"]}/rules', {'trigger': 'access', 'stage': s['id'], 'action': action, 'config': cfg}))
    return s
tri = stage_with('Triagem', 'backlog', [('allow_act', {'roles': [est_role['id']]}), ('allow_enter', {'roles': [est_role['id']]}), ('responsible', {'users': [est['id']]})])
dev = stage_with('Desenvolvimento', tri['id'], [('allow_act', {'roles': [jun_role['id']]}), ('allow_enter', {'roles': [jun_role['id']]}), ('lock_fields', {'fields': ['title']})])
check(next(x for x in ok(C('GET', f'/workspaces/{ws["id"]}/stages')) if x['id'] == dev['id'])['policy']['locked'] == ['title'], 'a etapa resume as regras de acesso dela')
st, r = C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'access', 'stage': dev['id'], 'action': 'allow_act', 'config': {'users': [zed['id']]}})
check(st == 400 and 'não tem acesso' in r['error'], 'regra de acesso não aceita pessoa sem acesso ao workspace')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'access', 'stage': dev['id'], 'action': 'notify', 'config': {'to': 'team'}})[0] == 400, 'regra de acesso só aceita ações de acesso')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'access', 'stage': dev['id'], 'action': 'approval', 'config': {'approvals': 0, 'to': 'done'}})[0] == 400, 'aprovação pede ao menos 1 pessoa')
check(E_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'com agente', 'status': tri['id'], 'agentId': ag['id']})[0] == 403, 'estagiário não escolhe agente ao criar')
check(E_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'urgente', 'status': tri['id'], 'priority': 1})[0] == 403, 'estagiário não define prioridade')
T = ok(E_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Pedido do cliente', 'status': tri['id']}))['issue']
check(J_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x', 'status': tri['id']})[0] == 403, 'júnior não cria issue na Triagem (entrada restrita)')
check(J_('PATCH', f'/issues/{T["id"]}', {'description': 'mexendo'})[0] == 403, 'júnior não mexe em issue da Triagem')
check(ok(E_('GET', f'/issues/{T["id"]}'))['caps']['edit'] and not ok(J_('GET', f'/issues/{T["id"]}'))['caps']['edit'], 'a issue informa o que cada um pode fazer')
check(E_('PATCH', f'/issues/{T["id"]}', {'agentId': ag['id']})[0] == 403, 'estagiário não troca agente depois de criada')
check(E_('PATCH', f'/issues/{T["id"]}', {'status': dev['id']})[0] == 403, 'estagiário não manda para Desenvolvimento (só o júnior traz)')
ok(own('PATCH', f'/issues/{T["id"]}', {'status': dev['id']}))
check(E_('PATCH', f'/issues/{T["id"]}', {'description': 'x'})[0] == 403, 'em Desenvolvimento o estagiário não mexe mais')
check(J_('PATCH', f'/issues/{T["id"]}', {'description': 'detalhado'})[0] == 200, 'júnior mexe na issue do Desenvolvimento')
st, r = J_('PATCH', f'/issues/{T["id"]}', {'title': 'novo'})
check(st == 403 and 'travado' in r['error'], 'campo travado na etapa não muda: ' + r.get('error', ''))
check(own('PATCH', f'/issues/{T["id"]}', {'assigneeId': zed['id']})[0] == 400, 'responsável precisa ter acesso ao workspace')

# requisitos, limite e aprovação dupla
qa2 = stage_with('Homologação', 'in_review', [('require', {'requires': ['assignee']}), ('wip', {'wip': 1}), ('approval', {'approvals': 2, 'to': 'done'})])
st, r = own('PATCH', f'/issues/{T["id"]}', {'status': qa2['id']})
check(st == 400 and 'responsável' in r['error'], 'requisito da etapa: precisa de responsável')
ok(own('PATCH', f'/issues/{T["id"]}', {'assigneeId': jun['id'], 'status': qa2['id']}))
U = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Outra', 'status': 'backlog'}))['issue']
ok(A('PATCH', f'/issues/{U["id"]}', {'assigneeId': ana['id']}))
st, r = A('PATCH', f'/issues/{U["id"]}', {'status': qa2['id']})
check(st == 400 and 'máximo' in r['error'], 'limite de issues da etapa')
check(E_('POST', f'/issues/{T["id"]}/approve')[0] == 403, 'quem não tem permissão de aprovar não aprova')
res = ok(A('POST', f'/issues/{T["id"]}/approve'))
check(res['approvals'] == 1 and res['issue']['status'] == qa2['id'], 'primeira aprovação registrada (1 de 2), a issue espera')
res = ok(own('POST', f'/issues/{T["id"]}/approve'))
check(res['issue']['status'] == 'done', 'segunda aprovação leva para o destino')

# regras: destinatários só com acesso, gatilhos e condições
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'notify', 'config': {'to': 'users', 'users': [zed['id']]}})[0] == 400, 'notificar pessoa sem acesso ao workspace é recusado')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'notify', 'config': {'to': 'emails', 'emails': 'a@b.c'}})[0] == 400, 'e-mail digitado não é mais aceito (só pessoas e grupos)')
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'comment', 'conditions': {'priorities': [1]}, 'config': {'message': 'URGENTE: avisar o plantão'}}))
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'assign', 'conditions': {'priorities': [1]}, 'config': {'mode': 'balance', 'roles': [jun_role['id'], est_role['id']]}}))
h1 = ok(own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Site fora do ar', 'description': 'cliente reclamou', 'status': tri['id'], 'priority': 1}))['issue']
h2 = ok(own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Ajuste de texto', 'status': tri['id'], 'priority': 3}))['issue']
time.sleep(1.5)
i1 = ok(own('GET', f'/issues/{h1["id"]}')); i2 = ok(own('GET', f'/issues/{h2["id"]}'))
check(any('URGENTE' in c['body'] for c in i1['comments']) and not any('URGENTE' in c['body'] for c in i2['comments']), 'regra de issue criada com condição de prioridade')
check(i1['issue']['assigneeId'] in (est['id'], jun['id']), 'regra distribui o responsável entre os perfis escolhidos')

# ordem das etapas, alertas e cópia do fluxo para outro workspace
check(isinstance(ok(C('GET', f'/workspaces/{ws2["id"]}/workflow/warnings')), list), 'alertas vêm como lista (vazia quando não há)')
cur = [x['id'] for x in ok(C('GET', f'/workspaces/{ws["id"]}/stages'))]
new = cur[1:] + cur[:1]
check([x['id'] for x in ok(C('PUT', f'/workspaces/{ws["id"]}/stages/order', {'ids': new}))] == new, 'etapas podem ser reordenadas')
ok(C('PUT', f'/workspaces/{ws["id"]}/stages/order', {'ids': cur}))
prev = ok(C('POST', f'/workspaces/{ws["id"]}/workflow/copy', {'to': ws2['id'], 'dryRun': True}))
check(any('est' in w['message'] for w in prev['warnings']), 'cópia avisa quem não tem acesso ao destino')
ok(C('POST', f'/workspaces/{ws["id"]}/workflow/copy', {'to': ws2['id']}))
s2 = ok(C('GET', f'/workspaces/{ws2["id"]}/stages'))
tri2 = next(x for x in s2 if x['name'] == 'Triagem')
check(tri2['policy']['act']['roles'] == [est_role['id']] and not tri2['policy']['responsible'].get('users'), 'cópia leva perfis e tira pessoas sem acesso')
check(A('POST', f'/workspaces/{ws["id"]}/workflow/copy', {'to': ws2['id']})[0] == 403, 'copiar fluxo exige permissão')

# skill vinculada a agentes; chave do workspace não muda
sk = ok(C('POST', '/skills', {'name': 'Checklist', 'description': 'd', 'content': 'x'}))
ok(C('PUT', f'/skills/{sk["id"]}/agents', {'agentIds': [ag['id']]}))
check(sk['id'] in next(a for a in ok(A('GET', '/agents')) if a['id'] == ag['id'])['skillIds'], 'skill vinculada aparece no agente')
ok(C('PUT', f'/skills/{sk["id"]}/agents', {'agentIds': []}))
check(sk['id'] not in next(a for a in ok(A('GET', '/agents')) if a['id'] == ag['id'])['skillIds'], 'desvincular tira a skill do agente')
ok(own('PATCH', f'/workspaces/{ws["id"]}/', {'name': 'Loja', 'key': 'OUTRA'}))
check([w['key'] for w in ok(own('GET', '/workspaces')) if w['id'] == ws['id']] == ['LOJA'], 'a chave do workspace não muda')

# etapa somente leitura, desempenho no analytics, regras de e-mail esperando o envio
arq = stage_with('Arquivada', 'done', [('read_only', {})])
R = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Para arquivar', 'status': 'backlog'}))['issue']
ok(A('PATCH', f'/issues/{R["id"]}', {'status': arq['id']}))
st, r = A('PATCH', f'/issues/{R["id"]}', {'title': 'mudou'})
check(st == 403 and 'somente leitura' in r['error'], 'etapa somente leitura: ninguém edita')
check(A('POST', f'/issues/{R["id"]}/comments', {'body': 'oi'})[0] == 403 and A('PATCH', f'/issues/{R["id"]}', {'status': 'backlog'})[0] == 403, 'somente leitura: sem comentar nem tirar de lá')
check(not ok(A('GET', f'/issues/{R["id"]}'))['caps']['edit'] and own('PATCH', f'/issues/{R["id"]}', {'status': 'backlog'})[0] == 200, 'só o dono sai da etapa somente leitura')
an = ok(own('GET', f'/analytics?days=30&workspace={ws["id"]}'))
check(isinstance(an['priorities'], list) and any(p['priority'] == 0 for p in an['priorities']), 'analytics: custo por prioridade')
names = [x['name'] for x in an['stageTimes']]
check('Em andamento' in names and 'Arquivada' in names, 'analytics: tempo médio por etapa ' + str(names[:6]))
check(isinstance(an['creators'], list) and an['creators'] and 'medResolveHours' in an['issues'], 'analytics: custo por quem criou e mediana do ciclo')
check(ok(own('GET', '/settings/email'))['notifyRules'] >= 1, 'servidor conta as regras de e-mail esperando o envio')

# ordem das regras definida pelo usuário + passo de IA que espera terminar na etapa
ria = ok(C('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'Revisão por IA', 'after': 'in_progress'}))
mk_rule = lambda action, cfg: ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': ria['id'], 'action': action, 'config': cfg}))
rD = mk_rule('move', {'to': 'in_review'})
rC = mk_rule('comment', {'message': 'passo 3: depois da IA'})
rB = mk_rule('run_agent', {'agentId': ag['id'], 'request': 'revise DEVAGAR', 'wait': True})
rA = mk_rule('comment', {'message': 'passo 1: chegou'})
ordered = ok(C('PUT', f'/workspaces/{ws["id"]}/rules/order', {'ids': [rA['id'], rB['id'], rC['id'], rD['id']]}))
seq = sorted([x for x in ordered if x['stage'] == ria['id']], key=lambda x: x['position'])
check([x['id'] for x in seq] == [rA['id'], rB['id'], rC['id'], rD['id']], 'usuário define a ordem das regras da etapa')
V = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Passos', 'status': 'backlog', 'agentId': ag['id'], 'repoIds': [repos['api']['id']]}))['issue']
ok(own('PATCH', f'/issues/{V["id"]}', {'status': ria['id']}))
held = False
for _ in range(120):
    d = ok(A('GET', f'/issues/{V["id"]}'))
    if d['issue']['activeRun'] and d['issue']['status'] == ria['id']: held = True
    if d['issue']['status'] == 'in_review' and not d['issue']['activeRun']: break
    time.sleep(0.25)
check(held, 'a issue fica na etapa enquanto o agente do passo trabalha')
time.sleep(1)
d = ok(A('GET', f'/issues/{V["id"]}'))
bodies = [c['body'] for c in d['comments']]
idx = lambda txt: next((i for i, b in enumerate(bodies) if txt in b), -1)
check(d['issue']['status'] == 'in_review' and d['runs'][-1]['holdStage'], 'depois do passo de IA a sequência segue e o mover vem por último')
check(0 <= idx('passo 1') < idx('terminou') < idx('passo 3') < idx('movida para'), 'regras rodaram na ordem: avisa, IA, depois da IA, move')

an = ok(own('GET', f'/analytics?days=30&workspace={ws["id"]}'))
pp = {p['name']: p for p in an['people']}
check('ana' in pp and pp['ana']['created'] > 0 and pp['ana']['runs'] > 0 and 'replyHours' in pp['ana'], 'analytics: desempenho por pessoa (criou, pedidos, tempo de resposta)')
check(pp.get('ana', {}).get('approvals', 0) >= 1 and pp.get('jun', {}).get('openAssigned', -1) >= 0, 'analytics: aprovações e responsabilidades por pessoa')

# permissões por tela e perfil de cada pessoa
check(Bb('GET', '/analytics?days=30')[0] in (200,) and login('est')('GET', '/analytics?days=30')[0] == 403, 'Analytics só para quem tem "ver analytics"')
prof = ok(A('GET', f'/users/{est["id"]}/profile'))
loja = next(w for w in prof['workspaces'] if w['key'] == 'LOJA')
check(any(r.startswith('Triagem:') and 'mexe nas issues' in r and 'é responsável' in r for r in loja['roles']), 'perfil mostra o que a pessoa faz em cada etapa: ' + str(loja['roles']))
check(loja['created'] >= 1 and 'OUT' not in [w['key'] for w in prof['workspaces']], 'perfil traz as issues dela e só os workspaces que ela e quem vê compartilham')
check(login('est')('GET', f'/users/{ana["id"]}/profile')[0] == 403, 'sem "ver usuários" não abre perfis')
roles_now = {r['name']: r for r in ok(own('GET', '/roles'))}
check(all(p in roles_now['Membro']['permissions'] for p in ['user.view', 'workflow.view', 'analytics.view']) and 'workflow.manage' not in roles_now['Membro']['permissions'], 'Membro vê as telas em modo leitura')

# etapas em paralelo
pri = ok(C('POST', f'/workspaces/{ws2["id"]}/stages', {'name': 'Prioridade', 'after': 'backlog'}))
dif = ok(C('POST', f'/workspaces/{ws2["id"]}/stages', {'name': 'Difícil', 'after': pri['id']}))
med = ok(C('POST', f'/workspaces/{ws2["id"]}/stages', {'name': 'Médio', 'after': dif['id'], 'parallel': True}))
sts = ok(C('GET', f'/workspaces/{ws2["id"]}/stages'))
ids = [x['id'] for x in sts]
check(next(x for x in sts if x['id'] == med['id'])['parallel'] and ids.index(med['id']) == ids.index(dif['id']) + 1, 'etapa em paralelo fica logo depois da anterior')
ok(C('PUT', f'/workspaces/{ws2["id"]}/stages/{med["id"]}', {'name': 'Médio', 'parallel': False}))
check(not next(x for x in ok(C('GET', f'/workspaces/{ws2["id"]}/stages')) if x['id'] == med['id'])['parallel'], 'dá para tirar a etapa do paralelo')
# fluxo padrão: nada é fixo por etapa, tudo são regras editáveis
ws3 = ok(own('POST', '/workspaces', {'name': 'Novo', 'key': 'NOVO'}))
r3 = ok(own('GET', f'/workspaces/{ws3["id"]}/rules'))
has = lambda trig, act, **cfg: any(r['trigger'] == trig and r['action'] == act and all(r['config'].get(k) == v for k, v in cfg.items()) for r in r3)
check(has('run_started', 'move', to='in_progress') and has('run_finished', 'move', to='blocked') and has('merged', 'move', to='done')
      and has('enter', 'run_agent') and has('access', 'close', kind='done'), 'workspace novo nasce com o fluxo padrão em regras')
s3 = ok(own('GET', f'/workspaces/{ws3["id"]}/stages'))
check(next(x for x in s3 if x['id'] == 'done')['policy'].get('close') == 'done', 'Concluída encerra a issue por regra, não por ser "do sistema"')
N = ok(own('POST', f'/workspaces/{ws3["id"]}/issues', {'title': 'Sem repo', 'status': 'todo', 'agentId': ag['id']}))['issue']
time.sleep(2)
dn = ok(own('GET', f'/issues/{N["id"]}'))
check(dn['issue']['status'] == 'blocked' and any('não tem repositório' in c['body'] for c in dn['comments']), 'sem repositório a regra de rodar o agente falha, avisa e "uma regra falhou" leva para Bloqueada')
check(has('rule_failed', 'move', to='blocked'), 'regra padrão: uma regra falhou → Bloqueada')
ok(own('PATCH', f'/issues/{N["id"]}', {'status': 'done'}))
check(ok(own('GET', f'/issues/{N["id"]}'))['issue']['closed'] == 'done', 'entrar numa etapa com "Encerrar" conta como resolvida')
ok(own('PUT', f'/workspaces/{ws3["id"]}/stages/backlog', {'name': 'Ideias'}))
st_del = own('DELETE', f'/workspaces/{ws3["id"]}/stages/backlog')
check(st_del[0] in (200, 204), f'qualquer etapa pode ser removida, inclusive as do fluxo padrão ({st_del})')
for x in ok(own('GET', f'/workspaces/{ws3["id"]}/stages'))[1:]:
    own('DELETE', f'/workspaces/{ws3["id"]}/stages/{x["id"]}')
left = ok(own('GET', f'/workspaces/{ws3["id"]}/stages'))
check(len(left) == 1 and own('DELETE', f'/workspaces/{ws3["id"]}/stages/{left[0]["id"]}')[0] == 400, 'o fluxo precisa de pelo menos uma etapa')
check(ok(own('GET', f'/issues/{N["id"]}'))['issue']['status'] == left[0]['id'], 'issue de etapa removida vai para a primeira que sobra')
an = ok(own('GET', f'/analytics?days=30&workspace={ws["id"]}'))
kinds = {x['stage']: x['kind'] for x in an['stageTimes']}
check(kinds.get('in_progress') == 'ai' and kinds.get('waiting') == 'people' and any(k['kind'] == 'ai' for k in an['kindTimes']), 'analytics classifica as etapas pelas regras: ' + str(kinds))
print('FALHAS:', fails)

