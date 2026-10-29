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
    print(('OK   ' if cond else 'FAIL ') + label); fails += 0 if cond else 1
def ok(res):
    st, body = res
    if st != 200: raise SystemExit(f'FAILURE {st} {body}')
    return body
def git(repo, *args):
    return subprocess.run(['git', f'--git-dir={REM}/{repo}.git', *args], capture_output=True, text=True).stdout.strip()
def remote_has(repo, branch): return git(repo, 'rev-parse', '--verify', '-q', branch) != ''
def show(repo, path, ref='main'): return git(repo, 'show', f'{ref}:{path}')

own = session()
st, me = own('POST', '/setup', {'name': 'Owner', 'email': 'owner@x.com', 'password': 'password1234'})
check(me['isOwner'] and me['permissions'] == ['*'] and me['roleName'] == 'Administrator', 'first sign-up = owner with everything')

# ---------- roles ----------
roles = {r['name']: r for r in ok(own('GET', '/roles'))}
check(set(roles) == {'Administrator', 'Member'}, 'default roles: Administrator and Member')
check(own('POST', '/roles', {'name': 'X', 'permissions': ['fly']})[0] == 400, 'unknown permission is refused')
reader = ok(own('POST', '/roles', {'name': 'Reader', 'permissions': []}))
ws = ok(own('POST', '/workspaces', {'name': 'Shop', 'key': 'SHOP'}))
ws2 = ok(own('POST', '/workspaces', {'name': 'Other', 'key': 'OTH'}))
mk = lambda n, role, wss: ok(own('POST', '/users', {'name': n, 'email': f'{n}@x.com', 'password': 'password1234', 'roleId': role, 'workspaceIds': wss}))
ana = mk('ana', roles['Member']['id'], [ws['id']]); bob = mk('bob', reader['id'], [ws['id']]); carlos = mk('carlos', roles['Administrator']['id'], [])
def login(n):
    s = session(); ok(s('POST', '/login', {'email': f'{n}@x.com', 'password': 'password1234'})); return s
A, Bb, C = login('ana'), login('bob'), login('carlos')
check(ok(A('GET', '/me'))['roleName'] == 'Member', 'user created with the chosen role')
check([w['key'] for w in ok(A('GET', '/workspaces'))] == ['SHOP'] and len(ok(C('GET', '/workspaces'))) == 2, 'Member sees only the linked one; Administrator sees all')
check(C('POST', '/roles', {'name': 'Y', 'permissions': []})[0] == 403, 'only the owner creates roles (Administrator does not)')
check(C('GET', '/roles')[0] == 200, 'Administrator reads roles to assign them')
check(C('PATCH', f'/users/{me["id"]}', {'name': 'hack'})[0] == 403 and C('DELETE', f'/users/{me["id"]}')[0] == 400, 'nobody edits or removes the owner')
check(Bb('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x'})[0] == 403, 'Reader does not create issues')
check(A('POST', '/agents', {'name': 'x'})[0] == 403 and A('POST', '/skills', {'name': 'x'})[0] == 403, 'Member creates neither agents nor skills')
check(A('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'x'})[0] == 403, 'Member does not add repositories')
st, i0 = A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'from ana'})
check(st == 200, 'Member creates an issue')
check(A('DELETE', f'/issues/{i0["issue"]["id"]}')[0] == 403, 'Member does not delete issues (no issue.delete)')
ok(own('PUT', f'/roles/{roles["Member"]["id"]}', {'name': 'Member', 'permissions': roles['Member']['permissions'] + ['issue.delete']}))
check(A('DELETE', f'/issues/{i0["issue"]["id"]}')[0] == 200, 'the owner grants issue.delete on the role and it applies at once')
check(own('DELETE', f'/roles/{reader["id"]}')[0] == 400, 'a role in use cannot be deleted')
check(Bb('GET', f'/workspaces/{ws["id"]}/issues')[0] == 200 and Bb('GET', f'/workspaces/{ws2["id"]}/issues')[0] == 404, 'Reader sees their workspace and gets 404 on the other')
ok(own('PATCH', f'/users/{bob["id"]}', {'roleId': roles['Member']['id']}))
check(Bb('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'now allowed'})[0] == 200, 'changing the user role changes the permissions')

# ---------- repositories ----------
check(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/api.git'})[0] == 400, 'a repository without a name is refused')
st, r = C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/missing.git', 'name': 'missing'})
check(st == 400 and 'not a git repository' in r['error'], 'a URL that is not a git repo is refused: ' + r.get('error', '')[:70])
desc = {'api': 'REST API (orders and payments)', 'web': 'The shop React front end', 'docs': 'Documentation'}
repos = {n: ok(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': f'file:///remote/{n}.git', 'name': n, 'description': desc[n]})) for n in ['api', 'web', 'docs']}
check(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/api.git', 'name': 'API'})[0] == 400, 'a repeated repository name is refused')
ag = ok(C('POST', '/agents', {'name': 'Fake', 'runtime': 'claude'}))

def wait(s, iid, states, t=60):
    for _ in range(t * 4):
        d = ok(s('GET', f'/issues/{iid}'))
        if d['issue']['status'] in states and not d['issue']['activeRun']: return d
        time.sleep(0.25)
    raise SystemExit(f'timeout: {d["issue"]["status"]} {d["runs"][-1:]}')
def rmap(issue): return {r['name']: r for r in issue['repos']}

# ---------- an issue on every repository: the AI touches only the api ----------
I = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Order discount', 'description': 'change the api', 'status': 'todo', 'agentId': ag['id']}))['issue']
check(I['allRepos'] and sorted(rmap(I)) == ['api', 'docs', 'web'], 'a new issue gets every repository of the workspace')
d = wait(A, I['id'], ['in_review', 'blocked'])
rm = rmap(d['issue'])
check(d['issue']['status'] == 'in_review', f'the run ended in review ({d["runs"][-1]["error"]})')
check(rm['api']['changed'] and not rm['web']['changed'] and not rm['docs']['changed'], 'only the api is marked as changed')
br = I['branch']
check(remote_has('api', br) and not remote_has('web', br) and not remote_has('docs', br), 'branch published only on the changed repository')
evs = ok(A('GET', f'/runs/{d["runs"][-1]["id"]}/events'))
prompt = next(e['body'] for e in evs if e['kind'] == 'prompt')
check('`api/` — **api**: REST API (orders and payments)' in prompt and 'touch only those' in prompt, 'the prompt carries the repository map with descriptions')
check(d['runs'][-1]['commitSha'].startswith('api '), 'commit recorded per repository: ' + d['runs'][-1]['commitSha'])

# adjustment: now it touches the web too
ok(A('POST', f'/issues/{I["id"]}/comments', {'body': 'adjust the front end', 'sendToAgent': True}))
d = wait(A, I['id'], ['in_review', 'blocked'])
rm = rmap(d['issue'])
check(rm['api']['changed'] and rm['web']['changed'], 'an adjustment by comment changed the web, the api stays')
diff = ok(A('GET', f'/issues/{I["id"]}/diff'))
check(sorted(x['name'] for x in diff) == ['api', 'web'], 'diff split per repository (changed ones only)')
check(all('permission' not in a for a in ok(A('GET', '/agents'))) and all('setupScript' not in x for x in ok(A('GET', f'/workspaces/{ws["id"]}/repos'))), 'no per-agent permission nor setup/env/protected branches on the repository')
res = ok(A('POST', f'/issues/{I["id"]}/merge', {}))
check(not res['conflict'] and sorted(r['name'] for r in res['repos']) == ['api', 'web'], 'merge done on both changed repositories')
check('api change' in show('api', 'main.txt') and 'web adjustment' in show('web', 'main.txt') and show('docs', 'main.txt') == 'docs v1', 'main of api and web received it; docs untouched')
d = wait(A, I['id'], ['done'], 10)  # "merge done → Done" is a rule: it takes a moment
check(d['issue']['status'] == 'done' and not remote_has('api', br) and not remote_has('web', br), 'issue done and its branches removed')

# ---------- a chosen scope: web only ----------
J = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Front only', 'description': 'WEB_ONLY', 'status': 'todo', 'agentId': ag['id'], 'repoIds': [repos['web']['id']]}))['issue']
check(not J['allRepos'] and list(rmap(J)) == ['web'], 'an issue with a chosen scope gets only the web')
d = wait(A, J['id'], ['in_review', 'blocked'])
evs = ok(A('GET', f'/runs/{d["runs"][-1]["id"]}/events'))
prompt = next(e['body'] for e in evs if e['kind'] == 'prompt')
check('isolated git worktree' in prompt and '**web** repository' in prompt and rmap(d['issue'])['web']['changed'], 'with a single repository, the agent works right in it')

# ---------- conflict between issues: nothing is published halfway ----------
P = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'P', 'description': 'CONFLICT_P', 'status': 'todo', 'agentId': ag['id']}))['issue']
Q = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Q', 'description': 'CONFLICT_Q', 'status': 'todo', 'agentId': ag['id']}))['issue']
wait(A, P['id'], ['in_review']); dq = wait(A, Q['id'], ['in_review'])
check(sorted(n for n, r in rmap(dq['issue']).items() if r['changed']) == ['api', 'web'], 'Q changed api and web')
ok(A('POST', f'/issues/{P["id"]}/merge', {}))
web_before = git('web', 'rev-parse', 'main')
res = ok(A('POST', f'/issues/{Q["id"]}/merge', {}))
check(res['conflict'] and [r['name'] for r in res['repos'] if r.get('conflict')] == ['api'], 'merge of Q: conflict detected in the api')
check(git('web', 'rev-parse', 'main') == web_before and not show('web', 'q.txt'), 'conflict in the api: the web was not published either (all or nothing)')
dq = ok(A('GET', f'/issues/{Q["id"]}'))
check(dq['issue']['status'] == 'blocked' and rmap(dq['issue'])['api']['conflict'], 'issue blocked with the conflicting repo marked')
ok(A('POST', f'/issues/{Q["id"]}/run', {'kind': 'conflict'}))
dq = wait(A, Q['id'], ['in_review', 'blocked'])
check(dq['issue']['status'] == 'in_review' and not rmap(dq['issue'])['api']['conflict'], f'the AI resolved the conflict ({dq["runs"][-1]["error"]})')
res = ok(A('POST', f'/issues/{Q["id"]}/merge', {}))
check(not res['conflict'] and show('api', 'conf.txt') == 'resolved' and show('web', 'q.txt') == 'file from Q', 'merging after the resolution publishes api and web')

# ---------- a new repository joins the open issues on "all" ----------
K = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Open', 'status': 'backlog'}))['issue']
subprocess.run(['git', 'clone', '-q', '--bare', f'{REM}/docs.git', f'{REM}/mobile.git'])
ok(C('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/mobile.git', 'name': 'mobile', 'description': 'Mobile app'}))
check('mobile' in rmap(ok(A('GET', f'/issues/{K["id"]}'))['issue']), 'a new repository joins the open issues on "all"')
st, k2 = A('PUT', f'/issues/{K["id"]}/repos', {'all': False, 'repos': [{'repoId': repos['api']['id'], 'targetBranch': 'main'}]})
check(st == 200 and list(rmap(k2)) == ['api'] and not k2['allRepos'], 'switching the issue scope to the api only')
check(Bb('GET', '/git')[0] == 403 and C('GET', '/git')[0] == 200, 'git status only for whoever configures')
# ---------- workflow: routing, declared outcome, approval ----------
W = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Button color', 'description': 'NEEDS_DECISION', 'status': 'todo', 'agentId': ag['id'], 'repoIds': [repos['api']['id']]}))['issue']
# the rule engine runs in parallel: "agent started → In progress" takes a moment
seen = set()
for _ in range(40):
    seen.add(ok(A('GET', f'/issues/{W["id"]}'))['issue']['status'])
    if seen & {'in_progress', 'waiting'}: break
    time.sleep(0.1)
check('in_progress' in seen or 'waiting' in seen, 'a new request goes to In progress (the "agent started" rule)')
d = wait(A, W['id'], ['waiting', 'in_review', 'blocked'])
check(d['issue']['status'] == 'waiting' and d['runs'][-1]['outcome'] == 'waiting' and d['runs'][-1]['outcomeNote'] == 'blue or green?', 'the AI declares "waiting" and the issue goes to Waiting for you')
time.sleep(1.5)
coms = [c['body'] for c in ok(A('GET', f'/issues/{W["id"]}'))['comments']]
check(any('The AI needs you' in c and 'blue or green?' in c for c in coms), 'the AI question becomes a comment on the issue')
check(not any('Rule **Notify**' in c for c in coms), 'with e-mail off, the notify rule does not clutter the issue')
ok(A('POST', f'/issues/{W["id"]}/comments', {'body': 'blue', 'sendToAgent': True}))
seen = set()
for _ in range(40):
    seen.add(ok(A('GET', f'/issues/{W["id"]}'))['issue']['status'])
    if seen & {'in_progress', 'in_review'}: break
    time.sleep(0.1)
check(seen & {'in_progress', 'in_review'}, 'a reply to the agent goes back to In progress')
d = wait(A, W['id'], ['in_review', 'waiting', 'blocked'])
check(d['issue']['status'] == 'in_review' and d['runs'][-1]['outcome'] == 'done', 'the AI declares "done" and it goes to In review')
check(d['caps']['approve'] and d['caps']['approvals'] == 1, 'the issue says the person can approve')
check(A('POST', f'/issues/{K["id"]}/approve')[0] == 400, 'approving only applies to a stage with approval')
ok(A('POST', f'/issues/{W["id"]}/approve'))
for _ in range(40):
    d = ok(A('GET', f'/issues/{W["id"]}'))
    if rmap(d['issue'])['api']['mergedInto']: break
    time.sleep(0.25)
check(d['issue']['status'] == 'done' and rmap(d['issue'])['api']['mergedInto'] == 'main', 'approving leads to Done and the default rule merges')

# ---------- custom stages and rules ----------
check(A('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'QA'})[0] == 403, 'Member does not configure the workflow')
qa = ok(C('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'QA', 'color': '#22d3ee', 'after': 'in_review'}))
names = [x['name'] for x in ok(A('GET', f'/workspaces/{ws["id"]}/stages'))]
check(names.index('QA') == names.index('In review') + 1, 'a new stage comes after the chosen one')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': qa['id'], 'action': 'move', 'config': {'to': qa['id']}})[0] == 400, 'a rule that moves to its own stage is refused')
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': qa['id'], 'action': 'script', 'config': {'script': 'echo "qa of $FOREMAN_ISSUE coming from $FOREMAN_FROM"'}}))
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': qa['id'], 'action': 'move', 'config': {'to': 'backlog'}}))
X = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Workflow', 'status': 'in_review'}))['issue']
check(A('PATCH', f'/issues/{X["id"]}', {'status': 'missing'})[0] == 400, 'an unknown stage is refused')
ok(A('PATCH', f'/issues/{X["id"]}', {'status': qa['id']}))
for _ in range(40):
    d = ok(A('GET', f'/issues/{X["id"]}'))
    if d['issue']['status'] == 'backlog': break
    time.sleep(0.25)
coms = [c['body'] for c in d['comments']]
check(any(f'qa of SHOP-{X["number"]} coming from in_review' in c for c in coms), 'a script rule runs with the FOREMAN_* variables')
check(d['issue']['status'] == 'backlog' and any('moved to Backlog' in c for c in coms), 'a move rule forwards to the next stage')
loop = ok(C('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'Loop', 'after': 'backlog'}))
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': loop['id'], 'action': 'move', 'config': {'to': 'blocked'}}))
r_b = ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': 'blocked', 'action': 'move', 'config': {'to': loop['id']}}))
ok(A('PATCH', f'/issues/{X["id"]}', {'status': loop['id']}))
time.sleep(4)
coms = [c['body'] for c in ok(A('GET', f'/issues/{X["id"]}'))['comments']]
check(any('loop' in c for c in coms), 'rules in a loop stop on their own')
ok(C('DELETE', f'/rules/{r_b["id"]}'))
ok(C('DELETE', f'/workspaces/{ws["id"]}/stages/{qa["id"]}'))
ok(C('DELETE', f'/workspaces/{ws["id"]}/stages/{loop["id"]}'))
check('QA' not in [x['name'] for x in ok(A('GET', f'/workspaces/{ws["id"]}/stages'))], 'a custom stage can be removed')

# ---------- a company: same permission role, different jobs per stage ----------
base = ['issue.create', 'issue.edit', 'issue.move', 'issue.comment']
est_role = ok(own('POST', '/roles', {'name': 'Intern', 'permissions': base}))
jun_role = ok(own('POST', '/roles', {'name': 'Junior', 'permissions': base}))
est = mk('est', est_role['id'], [ws['id']]); jun = mk('jun', jun_role['id'], [ws['id']])
zed = mk('zed', roles['Member']['id'], [ws2['id']])  # only has access to the other workspace
E_, J_ = login('est'), login('jun')
# A stage is just a name and a position; who may, locks and approval are access rules.
def stage_with(name, after, access, w=None):
    w = w or ws
    s = ok(C('POST', f'/workspaces/{w["id"]}/stages', {'name': name, 'after': after}))
    for action, cfg in access:
        ok(C('POST', f'/workspaces/{w["id"]}/rules', {'trigger': 'access', 'stage': s['id'], 'action': action, 'config': cfg}))
    return s
tri = stage_with('Triage', 'backlog', [('allow_act', {'roles': [est_role['id']]}), ('allow_enter', {'roles': [est_role['id']]}), ('responsible', {'users': [est['id']]})])
dev = stage_with('Development', tri['id'], [('allow_act', {'roles': [jun_role['id']]}), ('allow_enter', {'roles': [jun_role['id']]}), ('lock_fields', {'fields': ['title']})])
check(next(x for x in ok(C('GET', f'/workspaces/{ws["id"]}/stages')) if x['id'] == dev['id'])['policy']['locked'] == ['title'], 'the stage summarizes its access rules')
st, r = C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'access', 'stage': dev['id'], 'action': 'allow_act', 'config': {'users': [zed['id']]}})
check(st == 400 and "doesn't have access" in r['error'], 'an access rule refuses a person without workspace access')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'access', 'stage': dev['id'], 'action': 'notify', 'config': {'to': 'team'}})[0] == 400, 'an access rule only takes access actions')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'access', 'stage': dev['id'], 'action': 'approval', 'config': {'approvals': 0, 'to': 'done'}})[0] == 400, 'approval needs at least 1 person')
check(E_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'with agent', 'status': tri['id'], 'agentId': ag['id']})[0] == 403, 'the intern does not pick an agent on creation')
check(E_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'urgent', 'status': tri['id'], 'priority': 1})[0] == 403, 'the intern does not set priority')
T = ok(E_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Customer request', 'status': tri['id']}))['issue']
check(J_('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x', 'status': tri['id']})[0] == 403, 'the junior does not create issues in Triage (restricted entry)')
check(J_('PATCH', f'/issues/{T["id"]}', {'description': 'editing'})[0] == 403, 'the junior does not touch Triage issues')
check(ok(E_('GET', f'/issues/{T["id"]}'))['caps']['edit'] and not ok(J_('GET', f'/issues/{T["id"]}'))['caps']['edit'], 'the issue tells what each one can do')
check(E_('PATCH', f'/issues/{T["id"]}', {'agentId': ag['id']})[0] == 403, 'the intern does not change the agent after creation')
check(E_('PATCH', f'/issues/{T["id"]}', {'status': dev['id']})[0] == 403, 'the intern does not send it to Development (only the junior brings it)')
ok(own('PATCH', f'/issues/{T["id"]}', {'status': dev['id']}))
check(E_('PATCH', f'/issues/{T["id"]}', {'description': 'x'})[0] == 403, 'in Development the intern no longer touches it')
check(J_('PATCH', f'/issues/{T["id"]}', {'description': 'detailed'})[0] == 200, 'the junior works on the Development issue')
st, r = J_('PATCH', f'/issues/{T["id"]}', {'title': 'new'})
check(st == 403 and 'locked' in r['error'], 'a field locked in the stage does not change: ' + r.get('error', ''))
check(own('PATCH', f'/issues/{T["id"]}', {'assigneeId': zed['id']})[0] == 400, 'the assignee needs workspace access')

# requirements, limit and double approval
qa2 = stage_with('Acceptance', 'in_review', [('require', {'requires': ['assignee']}), ('wip', {'wip': 1}), ('approval', {'approvals': 2, 'to': 'done'})])
st, r = own('PATCH', f'/issues/{T["id"]}', {'status': qa2['id']})
check(st == 400 and 'assignee' in r['error'], 'stage requirement: needs an assignee')
ok(own('PATCH', f'/issues/{T["id"]}', {'assigneeId': jun['id'], 'status': qa2['id']}))
U = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Another', 'status': 'backlog'}))['issue']
ok(A('PATCH', f'/issues/{U["id"]}', {'assigneeId': ana['id']}))
st, r = A('PATCH', f'/issues/{U["id"]}', {'status': qa2['id']})
check(st == 400 and 'maximum' in r['error'], 'the stage issue limit')
check(E_('POST', f'/issues/{T["id"]}/approve')[0] == 403, 'whoever lacks the approve permission does not approve')
res = ok(A('POST', f'/issues/{T["id"]}/approve'))
check(res['approvals'] == 1 and res['issue']['status'] == qa2['id'], 'first approval recorded (1 of 2), the issue waits')
res = ok(own('POST', f'/issues/{T["id"]}/approve'))
check(res['issue']['status'] == 'done', 'the second approval takes it to the destination')

# rules: recipients with access only, triggers and conditions
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'notify', 'config': {'to': 'users', 'users': [zed['id']]}})[0] == 400, 'notifying a person without workspace access is refused')
check(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'notify', 'config': {'to': 'emails', 'emails': 'a@b.c'}})[0] == 400, 'a typed e-mail is no longer accepted (only people and groups)')
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'comment', 'conditions': {'priorities': [1]}, 'config': {'message': 'URGENT: tell the on-call'}}))
ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': 'created', 'action': 'assign', 'conditions': {'priorities': [1]}, 'config': {'mode': 'balance', 'roles': [jun_role['id'], est_role['id']]}}))
h1 = ok(own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Site down', 'description': 'a customer complained', 'status': tri['id'], 'priority': 1}))['issue']
h2 = ok(own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Text tweak', 'status': tri['id'], 'priority': 3}))['issue']
time.sleep(1.5)
i1 = ok(own('GET', f'/issues/{h1["id"]}')); i2 = ok(own('GET', f'/issues/{h2["id"]}'))
check(any('URGENT' in c['body'] for c in i1['comments']) and not any('URGENT' in c['body'] for c in i2['comments']), 'an issue-created rule with a priority condition')
check(i1['issue']['assigneeId'] in (est['id'], jun['id']), 'the rule spreads the assignee across the chosen roles')

# stage order, warnings and copying the workflow to another workspace
check(isinstance(ok(C('GET', f'/workspaces/{ws2["id"]}/workflow/warnings')), list), 'warnings come as a list (empty when there are none)')
cur = [x['id'] for x in ok(C('GET', f'/workspaces/{ws["id"]}/stages'))]
new = cur[1:] + cur[:1]
check([x['id'] for x in ok(C('PUT', f'/workspaces/{ws["id"]}/stages/order', {'ids': new}))] == new, 'stages can be reordered')
ok(C('PUT', f'/workspaces/{ws["id"]}/stages/order', {'ids': cur}))
prev = ok(C('POST', f'/workspaces/{ws["id"]}/workflow/copy', {'to': ws2['id'], 'dryRun': True}))
check(any('est' in w['message'] for w in prev['warnings']), 'the copy warns who lacks access to the destination')
ok(C('POST', f'/workspaces/{ws["id"]}/workflow/copy', {'to': ws2['id']}))
s2 = ok(C('GET', f'/workspaces/{ws2["id"]}/stages'))
tri2 = next(x for x in s2 if x['name'] == 'Triage')
check(tri2['policy']['act']['roles'] == [est_role['id']] and tri2['policy']['responsible'].get('users') == [est['id']], 'the copy replaces the destination exactly like the origin (people included)')
check(any('est' in w['message'] for w in ok(C('GET', f'/workspaces/{ws2["id"]}/workflow/warnings'))), 'in the destination, whoever lacks access shows in the warnings to fix')
check(prev['replaced']['stages'] >= 8 and 'movedIssues' in prev, 'the preview says what will be deleted in the destination')
check(A('POST', f'/workspaces/{ws["id"]}/workflow/copy', {'to': ws2['id']})[0] == 403, 'copying the workflow requires permission')

# a skill linked to agents; the workspace key does not change
sk = ok(C('POST', '/skills', {'name': 'Checklist', 'description': 'd', 'content': 'x'}))
ok(C('PUT', f'/skills/{sk["id"]}/agents', {'agentIds': [ag['id']]}))
check(sk['id'] in next(a for a in ok(A('GET', '/agents')) if a['id'] == ag['id'])['skillIds'], 'a linked skill shows on the agent')
ok(C('PUT', f'/skills/{sk["id"]}/agents', {'agentIds': []}))
check(sk['id'] not in next(a for a in ok(A('GET', '/agents')) if a['id'] == ag['id'])['skillIds'], 'unlinking removes the skill from the agent')
ok(own('PATCH', f'/workspaces/{ws["id"]}/', {'name': 'Shop', 'key': 'OTHER'}))
check([w['key'] for w in ok(own('GET', '/workspaces')) if w['id'] == ws['id']] == ['SHOP'], 'the workspace key does not change')

# a read-only stage, analytics performance, e-mail rules waiting for sending
arq = stage_with('Archived', 'done', [('read_only', {})])
R = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'To archive', 'status': 'backlog'}))['issue']
ok(A('PATCH', f'/issues/{R["id"]}', {'status': arq['id']}))
st, r = A('PATCH', f'/issues/{R["id"]}', {'title': 'changed'})
check(st == 403 and 'read-only' in r['error'], 'a read-only stage: nobody edits')
check(A('POST', f'/issues/{R["id"]}/comments', {'body': 'hi'})[0] == 403 and A('PATCH', f'/issues/{R["id"]}', {'status': 'backlog'})[0] == 403, 'read-only: no commenting nor taking it out')
check(not ok(A('GET', f'/issues/{R["id"]}'))['caps']['edit'] and own('PATCH', f'/issues/{R["id"]}', {'status': 'backlog'})[0] == 200, 'only the owner leaves the read-only stage')
an = ok(own('GET', f'/workspaces/{ws["id"]}/analytics?days=30'))
check(isinstance(an['priorities'], list) and any(p['priority'] == 0 for p in an['priorities']), 'analytics: cost per priority')
names = [x['name'] for x in an['stageTimes']]
check('In progress' in names and 'Archived' in names, 'analytics: average time per stage ' + str(names[:6]))
check(isinstance(an['creators'], list) and an['creators'] and 'medResolveHours' in an['issues'], 'analytics: cost per creator and cycle median')
check(ok(own('GET', '/settings/email'))['notifyRules'] >= 1, 'the server counts the e-mail rules waiting for sending')

# rule order set by the user + an AI step that waits to finish in the stage
ria = ok(C('POST', f'/workspaces/{ws["id"]}/stages', {'name': 'AI review', 'after': 'in_progress'}))
mk_rule = lambda action, cfg: ok(C('POST', f'/workspaces/{ws["id"]}/rules', {'stage': ria['id'], 'action': action, 'config': cfg}))
rD = mk_rule('move', {'to': 'in_review'})
rC = mk_rule('comment', {'message': 'step 3: after the AI'})
rB = mk_rule('run_agent', {'agentId': ag['id'], 'request': 'review SLOWLY', 'wait': True})
rA = mk_rule('comment', {'message': 'step 1: arrived'})
ordered = ok(C('PUT', f'/workspaces/{ws["id"]}/rules/order', {'ids': [rA['id'], rB['id'], rC['id'], rD['id']]}))
seq = sorted([x for x in ordered if x['stage'] == ria['id']], key=lambda x: x['position'])
check([x['id'] for x in seq] == [rA['id'], rB['id'], rC['id'], rD['id']], 'the user sets the order of the stage rules')
V = ok(A('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'Steps', 'status': 'backlog', 'agentId': ag['id'], 'repoIds': [repos['api']['id']]}))['issue']
ok(own('PATCH', f'/issues/{V["id"]}', {'status': ria['id']}))
held = False
for _ in range(120):
    d = ok(A('GET', f'/issues/{V["id"]}'))
    if d['issue']['activeRun'] and d['issue']['status'] == ria['id']: held = True
    if d['issue']['status'] == 'in_review' and not d['issue']['activeRun']: break
    time.sleep(0.25)
check(held, 'the issue stays in the stage while the step agent works')
time.sleep(1)
d = ok(A('GET', f'/issues/{V["id"]}'))
bodies = [c['body'] for c in d['comments']]
idx = lambda txt: next((i for i, b in enumerate(bodies) if txt in b), -1)
check(d['issue']['status'] == 'in_review' and d['runs'][-1]['holdStage'], 'after the AI step the sequence goes on and the move comes last')
check(0 <= idx('step 1') < idx('finishes') < idx('step 3') < idx('moved to'), 'rules ran in order: notice, AI, after the AI, move')

an = ok(own('GET', f'/workspaces/{ws["id"]}/analytics?days=30'))
pp = {p['name']: p for p in an['people']}
check('ana' in pp and pp['ana']['created'] > 0 and pp['ana']['runs'] > 0 and 'replyHours' in pp['ana'], 'analytics: performance per person (created, requests, response time)')
check(pp.get('ana', {}).get('approvals', 0) >= 1 and pp.get('jun', {}).get('openAssigned', -1) >= 0, 'analytics: approvals and assignments per person')

# per-screen permissions and each person profile
check(Bb('GET', '/analytics?days=30')[0] in (200,) and login('est')('GET', '/analytics?days=30')[0] == 403, 'Analytics only for whoever has "view analytics"')
prof = ok(A('GET', f'/users/{est["id"]}/profile'))
loja = next(w for w in prof['workspaces'] if w['key'] == 'SHOP')
check(any(r.startswith('Triage:') and 'works on issues' in r and 'is an owner' in r for r in loja['roles']), 'the profile shows what the person does in each stage: ' + str(loja['roles']))
check(loja['created'] >= 1 and 'OTH' not in [w['key'] for w in prof['workspaces']], 'the profile brings their issues and only the workspaces they and the viewer share')
check(login('est')('GET', f'/users/{ana["id"]}/profile')[0] == 403, 'without "view users" profiles do not open')
roles_now = {r['name']: r for r in ok(own('GET', '/roles'))}
check(all(p in roles_now['Member']['permissions'] for p in ['user.view', 'workflow.view', 'analytics.view']) and 'workflow.manage' not in roles_now['Member']['permissions'], 'Member sees the screens read-only')

# parallel stages
pri = ok(C('POST', f'/workspaces/{ws2["id"]}/stages', {'name': 'Priority', 'after': 'backlog'}))
dif = ok(C('POST', f'/workspaces/{ws2["id"]}/stages', {'name': 'Hard', 'after': pri['id']}))
med = ok(C('POST', f'/workspaces/{ws2["id"]}/stages', {'name': 'Medium', 'after': dif['id'], 'parallel': True}))
sts = ok(C('GET', f'/workspaces/{ws2["id"]}/stages'))
ids = [x['id'] for x in sts]
check(next(x for x in sts if x['id'] == med['id'])['parallel'] and ids.index(med['id']) == ids.index(dif['id']) + 1, 'a parallel stage sits right after the previous one')
ok(C('PUT', f'/workspaces/{ws2["id"]}/stages/{med["id"]}', {'name': 'Medium', 'parallel': False}))
check(not next(x for x in ok(C('GET', f'/workspaces/{ws2["id"]}/stages')) if x['id'] == med['id'])['parallel'], 'a stage can be taken out of parallel')
# default workflow: nothing is fixed per stage, everything is editable rules
ws3 = ok(own('POST', '/workspaces', {'name': 'New', 'key': 'NEW'}))
r3 = ok(own('GET', f'/workspaces/{ws3["id"]}/rules'))
has = lambda trig, act, **cfg: any(r['trigger'] == trig and r['action'] == act and all(r['config'].get(k) == v for k, v in cfg.items()) for r in r3)
check(has('run_started', 'move', to='in_progress') and has('run_finished', 'move', to='blocked') and has('merged', 'move', to='done')
      and has('enter', 'run_agent') and has('access', 'close', kind='done'), 'a new workspace is born with the default workflow as rules')
s3 = ok(own('GET', f'/workspaces/{ws3["id"]}/stages'))
check(next(x for x in s3 if x['id'] == 'done')['policy'].get('close') == 'done', 'Done closes the issue by rule, not for being a "system" stage')
N = ok(own('POST', f'/workspaces/{ws3["id"]}/issues', {'title': 'No repo', 'status': 'todo', 'agentId': ag['id']}))['issue']
time.sleep(2)
dn = ok(own('GET', f'/issues/{N["id"]}'))
check(dn['issue']['status'] == 'blocked' and any('has no repository' in c['body'] for c in dn['comments']), 'without a repository the run-agent rule fails, warns, and "a rule failed" takes it to Blocked')
check(has('rule_failed', 'move', to='blocked'), 'default rule: a rule failed → Blocked')
ok(own('PATCH', f'/issues/{N["id"]}', {'status': 'done'}))
check(ok(own('GET', f'/issues/{N["id"]}'))['issue']['closed'] == 'done', 'entering a stage with "Close" counts as resolved')
ok(own('PUT', f'/workspaces/{ws3["id"]}/stages/backlog', {'name': 'Ideas'}))
st_del = own('DELETE', f'/workspaces/{ws3["id"]}/stages/backlog')
check(st_del[0] in (200, 204), f'any stage can be removed, the default ones included ({st_del})')
for x in ok(own('GET', f'/workspaces/{ws3["id"]}/stages'))[1:]:
    own('DELETE', f'/workspaces/{ws3["id"]}/stages/{x["id"]}')
left = ok(own('GET', f'/workspaces/{ws3["id"]}/stages'))
check(len(left) == 1 and own('DELETE', f'/workspaces/{ws3["id"]}/stages/{left[0]["id"]}')[0] == 400, 'the workflow needs at least one stage')
check(ok(own('GET', f'/issues/{N["id"]}'))['issue']['status'] == left[0]['id'], 'an issue of a removed stage goes to the first one left')
an = ok(own('GET', f'/workspaces/{ws["id"]}/analytics?days=30'))
kinds = {x['stage']: x['kind'] for x in an['stageTimes']}
check(kinds.get('in_progress') == 'ai' and kinds.get('waiting') == 'people' and any(k['kind'] == 'ai' for k in an['kindTimes']), 'analytics classifies the stages by the rules: ' + str(kinds))
# a paginated board: first N per stage, each stage total, page per stage and server search
for n in range(45):
    ok(own('POST', f'/workspaces/{ws3["id"]}/issues', {'title': f'Load {n:02d}', 'status': left[0]['id'], 'priority': n % 5}))
bd = ok(own('GET', f'/workspaces/{ws3["id"]}/board?limit=30'))
check(bd['counts'][left[0]['id']] >= 46 and sum(1 for i in bd['issues'] if i['status'] == left[0]['id']) == 30, 'the board brings only the first 30 of the stage and its total')
pg = ok(own('GET', f'/workspaces/{ws3["id"]}/issues?stage={left[0]["id"]}&offset=30&limit=40'))
ids1 = {i['id'] for i in bd['issues']}
check(len(pg) >= 16 and not any(i['id'] in ids1 for i in pg), 'the next page of the stage does not repeat the loaded ones')
old = ok(own('GET', f'/workspaces/{ws3["id"]}/issues?stage={left[0]["id"]}&sort=oldest&limit=1'))[0]
new = ok(own('GET', f'/workspaces/{ws3["id"]}/issues?stage={left[0]["id"]}&sort=newest&limit=1'))[0]
check(old['number'] < new['number'], 'order per stage: oldest and newest')
sr = ok(own('GET', f'/workspaces/{ws3["id"]}/issues?q=Load%2007'))
check(len(sr) == 1 and sr[0]['title'] == 'Load 07', 'server search by title')
check(ok(own('GET', f'/workspaces/{ws3["id"]}/board?q=Load%201'))['counts'].get(left[0]['id']) == 10, 'the board filter applies to the stage total')

# labels: their own screen and separate permissions
lb = ok(own('POST', f'/workspaces/{ws3["id"]}/labels', {'name': 'bug', 'color': '#ef4444'}))
ok(own('PATCH', f'/issues/{N["id"]}', {'labelIds': [lb['id']]}))
ls = ok(own('GET', f'/workspaces/{ws3["id"]}/labels'))
check(ls[0]['issues'] == 1, 'labels come with how many issues use them')
check(ok(own('PUT', f'/labels/{lb["id"]}', {'name': 'defect', 'color': '#f59e0b'}))['name'] == 'defect', 'rename a label')
check(own('POST', f'/workspaces/{ws3["id"]}/labels', {'name': 'defect'})[0] == 409, 'a label with a repeated name is refused')
perms = {p['id'] for p in ok(own('GET', '/permissions'))}
check({'label.view', 'label.create', 'label.update', 'label.delete'} <= perms and 'label.manage' not in perms, 'separate label permissions')
# analytics: workspace and overall, "just mine" and "everyone" are separate permissions
so_meu = ok(own('POST', '/roles', {'name': 'Just mine', 'permissions': ['analytics.view', 'issue.create']}))
eu = mk('me', so_meu['id'], [ws['id']]); E2 = login('me')
ok(E2('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'mine', 'status': 'backlog'}))
mine = ok(E2('GET', f'/workspaces/{ws["id"]}/analytics?days=30'))
check(mine['issues']['created'] == 1 and [p['name'] for p in mine['people']] == ['me'], 'without "team", workspace Analytics shows only the own numbers')
check(E2('GET', f'/workspaces/{ws["id"]}/analytics?days=30&person=all')[0] == 403 and E2('GET', f'/workspaces/{ws["id"]}/analytics?days=30&person={ana["id"]}')[0] == 403, 'without "team", sees neither everyone numbers nor another person')
check(E2('GET', '/analytics?days=30')[0] == 403, 'without "overall analytics", the overall one does not open')
ok(own('PUT', f'/roles/{so_meu["id"]}', {'name': 'Just mine', 'permissions': ['analytics.view', 'analytics.team', 'analytics.global', 'issue.create']}))
team = ok(E2('GET', f'/workspaces/{ws["id"]}/analytics?days=30&person=all'))
check(team['issues']['created'] > 1 and len(team['people']) > 1, 'with "team", sees everyone in the workspace')
check(ok(E2('GET', f'/workspaces/{ws["id"]}/analytics?days=30&person={ana["id"]}'))['people'][0]['name'] == 'ana', 'with "team", sees one person numbers')
g = ok(E2('GET', '/analytics?days=30'))
check([p['name'] for p in g['people']] == ['me'] and E2('GET', '/analytics?days=30&person=all')[0] == 403, 'overall without "overall team": only the own numbers')
print('FAILURES:', fails)

