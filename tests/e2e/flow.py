"""The complete flow and the rules under attack.

e2e.py checks that each feature does what it says. This suite tries to break them: every
scenario gets its own workspace and a real git remote, and the simulated agent is
programmed through [[MARKERS]] (see fake/claude).

Usage: flow.py [text]   runs only the scenarios whose name has that text.
"""
import concurrent.futures as cf, http.cookiejar, json, os, re, subprocess, sys, tempfile, threading, time, traceback
import urllib.error, urllib.request

BASE = 'http://127.0.0.1:18700'
B = BASE + '/api'
MAIL = 'http://127.0.0.1:18725/api/v1'
SINK = 'http://127.0.0.1:18790'
HERE = os.path.dirname(os.path.abspath(__file__))
REM = HERE + '/remote'
fails, passed = [], 0
current = ''


def session(lang=None):
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(m, p, body=None):
        headers = {'Content-Type': 'application/json'}
        if lang:
            headers['X-Lang'] = lang
        req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            r = op.open(req, timeout=60)
            t = r.read()
            return r.status, (json.loads(t) if t else None)
        except urllib.error.HTTPError as e:
            t = e.read()
            try:
                return e.code, json.loads(t or b'{}')
            except ValueError:
                return e.code, {'error': t.decode(errors='replace')[:200]}
    return call


def check(cond, label):
    global passed
    if cond:
        passed += 1
        print('OK   ' + label)
    else:
        fails.append(f'[{current}] {label}')
        print('FAIL ' + label)


def ok(res):
    st, body = res
    if st >= 300:
        raise AssertionError(f'unexpected {st}: {body}')
    return body


def get_json(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read() or b'null')


def dc(*args, check_=False):
    return subprocess.run(['docker', 'compose', '-f', os.environ['COMPOSE_FILE'], *args], capture_output=True, text=True, check=check_)


def psql(sql):
    return dc('exec', '-T', 'db', 'psql', '-U', 'foreman', '-d', 'foreman', '-Atc', sql).stdout.strip()


def sh(cmd):
    """Runs a command inside the Foreman container."""
    return dc('exec', '-T', 'foreman', 'bash', '-c', cmd).stdout.strip()


def healthy():
    try:
        return urllib.request.urlopen(B + '/health', timeout=5).status == 200
    except Exception:
        return False


def wait_until(fn, t=30, step=0.2):
    end = time.time() + t
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


# ---------- git ----------

def git(*args, cwd=None):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)


seq = {'n': 0}


def new_remote(tag, default='main', branches=('release',)):
    seq['n'] += 1
    name = f'{tag}{seq["n"]}'
    with tempfile.TemporaryDirectory() as d:
        git('init', '-q', '-b', default, d)
        open(d + '/main.txt', 'w').write(f'{tag} v1\n')
        open(d + '/conf.txt', 'w').write('base\n')
        git('add', '.', cwd=d)
        git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', cwd=d)
        for b in branches:
            git('branch', b, cwd=d)
        git('clone', '-q', '--bare', d, f'{REM}/{name}.git')
    return name


def rg(name, *args):
    return subprocess.run(['git', f'--git-dir={REM}/{name}.git', *args], capture_output=True, text=True).stdout.strip()


def has_ref(name, ref):
    return rg(name, 'rev-parse', '--verify', '-q', ref) != ''


def show(name, path, ref='main'):
    return rg(name, 'show', f'{ref}:{path}')


def set_hook(name, script):
    p = f'{REM}/{name}.git/hooks/pre-receive'
    if script is None:
        if os.path.exists(p):
            os.remove(p)
        return
    open(p, 'w').write('#!/bin/sh\n' + script + '\n')
    os.chmod(p, 0o755)


# ---------- fixtures ----------

own = session()
U = {}  # shared users
AG, CX = {}, {}


def login(email, pw='password1234', lang=None):
    s = session(lang)
    ok(s('POST', '/login', {'email': email, 'password': pw}))
    return s


def make_user(name, role_id, workspaces=()):
    return ok(own('POST', '/users', {'name': name, 'email': f'{name}@x.com', 'password': 'password1234', 'roleId': role_id, 'workspaceIds': list(workspaces)}))


def workspace(name, repos=('api',), default='main', members=('mem',), work=None):
    seq['n'] += 1
    w = ok(own('POST', '/workspaces', {'name': f'{name} {seq["n"]}', 'key': f'F{seq["n"]}'}))
    w['remotes'], w['repos'] = {}, {}
    for r in repos:
        remote = new_remote(r, default)
        w['remotes'][r] = remote
        w['repos'][r] = ok(own('POST', f'/workspaces/{w["id"]}/repos', {'url': f'file:///remote/{remote}.git', 'name': r, 'description': f'the {r} repository', 'workBranch': work or default}))
    for m in members:
        ok(own('PUT', f'/workspaces/{w["id"]}/members/{U[m]["id"]}'))
    return w


def issue(ws, title='Task', desc='', status='todo', agent=True, who=None, **kw):
    body = {'title': title, 'description': desc, 'status': status, **kw}
    if agent:
        body['agentId'] = AG['id']
    return ok((who or own)('POST', f'/workspaces/{ws["id"]}/issues', body))['issue']


def detail(iid, who=None):
    return ok((who or own)('GET', f'/issues/{iid}'))


def status(iid):
    return detail(iid)['issue']['status']


def settled(iid, states=None, t=30):
    """Waits for the issue to have no active run and to be in one of the states. Rules
    run in the background, so it also waits for the stage to stop changing."""
    last = None

    def done():
        nonlocal last
        d = detail(iid)
        last = d
        if d['issue']['activeRun'] or (states is None and not d['runs']):
            return None
        # Reaching Done starts the merge rule; it has settled when the merge has finished.
        if d['issue']['status'] == 'done' and any(r['changed'] and not r['mergedInto'] for r in d['issue']['repos']):
            return None
        return d if (states is None or d['issue']['status'] in states) else None
    d = wait_until(done, t)
    if d:
        return d
    raise AssertionError(f'timeout waiting for {states}: stage={last["issue"]["status"]} active={last["issue"]["activeRun"]} runs={[(r["status"], r["outcome"], r["error"]) for r in last["runs"]]} comments={[c["body"][:90] for c in last["comments"]]}')


def to_review(ws, title='Task', desc='[[WRITE:work.txt]]', **kw):
    """An issue with code changes, waiting for approval."""
    i = issue(ws, title, desc, **kw)
    return settled(i['id'], ['in_review'])['issue']


def rules(ws):
    return ok(own('GET', f'/workspaces/{ws["id"]}/rules'))


def add_rule(ws, trigger, action, config=None, stage='', conditions=None, enabled=True):
    return ok(own('POST', f'/workspaces/{ws["id"]}/rules', {'trigger': trigger, 'action': action, 'stage': stage, 'config': config or {}, 'conditions': conditions or {}, 'enabled': enabled}))


def add_stage(ws, name, after='backlog'):
    return ok(own('POST', f'/workspaces/{ws["id"]}/stages', {'name': name, 'after': after}))


def comments(iid):
    return [c['body'] for c in detail(iid)['comments']]


def has_comment(iid, text):
    return any(text in c for c in comments(iid))


def dbg(iid):
    """Where the simulated agent keeps a copy of its last args, prompt and env."""
    ref = psql(f"select w.key || '-' || i.number from issues i join workspaces w on w.id = i.workspace_id where i.id = '{iid}'")
    return f'/data/debug/{ref}'


def run_args(iid):
    return sh(f'cat {dbg(iid)}/last-args.txt')


SCENARIOS = []


def scenario(f):
    SCENARIOS.append(f)
    return f


# ======================================================================
# The complete flow
# ======================================================================

@scenario
def flow_complete_default_path():
    ws = workspace('Full')
    stream, stop = [], threading.Event()

    def listen():
        op = urllib.request.build_opener()
        req = urllib.request.Request(f'{B}/workspaces/{ws["id"]}/events', headers={'Cookie': own_cookie()})
        try:
            with op.open(req, timeout=40) as r:
                while not stop.is_set():
                    line = r.readline().decode()
                    if line.startswith('data: '):
                        stream.append(json.loads(line[6:]))
        except Exception:
            pass
    th = threading.Thread(target=listen, daemon=True)
    th.start()
    time.sleep(0.5)

    i = issue(ws, 'Add discount ÉÇÃ', 'Add a discount [[SLEEP:2]][[WRITE:discount.txt]]', who=login('mem@x.com'))
    check(wait_until(lambda: detail(i['id'])['issue']['activeRun'] and status(i['id']) == 'in_progress', 5), 'To do starts the agent and the issue goes to In progress')
    d = settled(i['id'], ['in_review'])
    r = d['runs'][-1]
    check(r['status'] == 'succeeded' and r['outcome'] == 'done', 'the run finished and went to In review')
    check(r['costUsd'] == 0.01 and r['inputTokens'] == 10 and r['cachedTokens'] == 5 and r['outputTokens'] == 2, 'cost and tokens recorded on the run')
    check(d['issue']['costUsd'] == 0.01, 'the issue adds up the cost of its runs')
    check(d['issue']['summary'].startswith('# Summary'), 'the README the agent wrote is saved on the issue')
    check(any(c['kind'] == 'agent' and c['body'] == 'Done.' for c in d['comments']), "the agent's final answer becomes a comment")
    br = d['issue']['branch']
    check(br.startswith(f'fm/{ws["key"].lower()}-') and re.fullmatch(r'[a-z0-9/-]+', br), 'a clean branch even with accents in the title: ' + br)
    remote = ws['remotes']['api']
    check(has_ref(remote, br) and show(remote, 'discount.txt', br) != '', 'the branch was published with the change')
    check(show(remote, 'discount.txt') == '', 'nothing reaches main before the approval')
    dif = ok(own('GET', f'/issues/{i["id"]}/diff'))
    check(len(dif) == 1 and 'discount.txt' in dif[0]['patch'], 'the diff shows the change')
    evs = ok(own('GET', f'/runs/{r["id"]}/events'))
    kinds = {e['kind'] for e in evs}
    check({'prompt', 'info', 'text', 'result'} <= kinds, f'the run log has prompt, info, text and result: {sorted(kinds)}')
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    d = settled(i['id'], ['done'])
    check(wait_until(lambda: detail(i['id'])['issue']['repos'][0]['mergedInto'] == 'main', 10), 'approving merges on the target branch')
    check(show(remote, 'discount.txt') != '' and not has_ref(remote, br), 'main received it and the branch was removed from the remote')
    d = detail(i['id'])
    check(d['issue']['closed'] == 'done' and d['issue']['doneAt'], 'Done closes the issue as resolved')
    check(sh('ls /data/tmp 2>/dev/null') == '', 'no temporary folder is left after the runs and the merge')
    log = psql(f"select string_agg(stage, ',' order by id) from issue_stage_log where issue_id='{i['id']}'")
    check(log == 'todo,in_progress,in_review,done', 'stage history: ' + log)
    an = ok(own('GET', f'/workspaces/{ws["id"]}/analytics?days=1&person=all'))
    check(an['totals']['runs'] == 1 and an['totals']['costUsd'] == 0.01 and an['issues']['resolved'] == 1, 'analytics counts the run, the cost and the resolved issue')
    time.sleep(1)
    stop.set()
    types = {e.get('type') for e in stream}
    check({'issue', 'run', 'run_event', 'comment'} <= types, f'the SSE stream delivered it live: {sorted(t for t in types if t)}')


def own_cookie():
    # A separate login: urllib's opener has its own jar, and SSE needs the raw cookie.
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request(B + '/login', method='POST', data=json.dumps({'email': 'owner@x.com', 'password': 'password1234'}).encode(), headers={'Content-Type': 'application/json'})
    op.open(req, timeout=10).read()
    return '; '.join(f'{c.name}={c.value}' for c in jar)


@scenario
def flow_without_agent_or_repository():
    ws = workspace('Manual')
    m = issue(ws, 'Manual task', agent=False)
    time.sleep(1)
    check(status(m['id']) == 'todo' and not detail(m['id'])['runs'], 'without an agent it stays in To do as a manual task')
    b = issue(ws, 'Idea', status='backlog')
    time.sleep(1)
    check(status(b['id']) == 'backlog' and not detail(b['id'])['runs'], 'Backlog does not run')
    empty = workspace('NoRepo', repos=())
    n = issue(empty, 'No repo')
    d = settled(n['id'], ['blocked'], 10)
    check(any('no repository' in c['body'] for c in d['comments']), 'without a repository: Blocked, with the reason')


@scenario
def flow_agent_outcomes():
    ws = workspace('Outcomes')
    w = settled(issue(ws, 'Q', '[[STATUS:waiting: which color?]]')['id'], ['waiting'])
    check(w['runs'][-1]['outcomeNote'] == 'which color?' and any('which color?' in c['body'] for c in w['comments']), 'waiting: the question becomes a comment and goes to Waiting')
    ok(own('POST', f'/issues/{w["issue"]["id"]}/comments', {'body': 'blue [[WRITE:color.txt]]', 'sendToAgent': True}))
    d = settled(w['issue']['id'], ['in_review'])
    check('blue' in sh(f'cat {dbg(w["issue"]["id"])}/last-prompt.txt') and 'which color?' in sh(f'cat {dbg(w["issue"]["id"])}/last-prompt.txt'), 'the reply goes in the prompt with the history of the question')
    check(d['runs'][-1]['kind'] == 'followup', 'a reply is an adjustment on the same issue')

    inc = settled(issue(ws, 'I', '[[STATUS:incomplete: no access to the API]]')['id'], ['waiting'])
    check(inc['runs'][-1]['outcome'] == 'incomplete' and any('no access' in c['body'] for c in inc['comments']), 'incomplete goes to Waiting, with the reason')

    ns = settled(issue(ws, 'N', '[[NO_STATUS]]')['id'], ['in_review'])
    check(ns['runs'][-1]['status'] == 'succeeded', 'no STATUS file counts as done')
    gs = settled(issue(ws, 'G', '[[STATUS:banana]]')['id'], ['in_review'])
    check(gs['runs'][-1]['outcome'] == '', 'a meaningless STATUS is ignored')

    ns2 = settled(issue(ws, 'No summary', '[[NO_SUMMARY]]')['id'], ['in_review'])
    check('Generated automatically' in ns2['issue']['summary'], 'without a README from the agent, the server generates one')

    nc = settled(issue(ws, 'No change', '[[NO_CHANGES]]')['id'], ['in_review'])
    check(not nc['issue']['repos'][0]['changed'] and not has_ref(ws['remotes']['api'], nc['issue']['branch']), 'without changes: no branch on the remote')
    ok(own('POST', f'/issues/{nc["issue"]["id"]}/approve'))
    d = settled(nc['issue']['id'], ['done'])
    check(d['issue']['status'] == 'done' and not any('failed' in c['body'] for c in d['comments']), 'approving without changes finishes without a merge or an error')

    ex = settled(issue(ws, 'Crash', '[[EXIT:3]]')['id'], ['blocked'])
    check(ex['runs'][-1]['status'] == 'failed' and any('The run failed' in c['body'] for c in ex['comments']), 'an agent that crashes goes to Blocked, with the reason')
    check(any('simulated crash' in e['body'] for e in ok(own('GET', f'/runs/{ex["runs"][-1]["id"]}/events'))), "the agent's stderr shows in the log")
    ok(own('POST', f'/issues/{ex["issue"]["id"]}/comments', {'body': 'try again [[WRITE:x.txt]]', 'sendToAgent': True}))
    check(settled(ex['issue']['id'], ['in_review'])['issue']['repos'][0]['changed'], 'a new request gets it out of Blocked')

    re_ = settled(issue(ws, 'ResultError', '[[RESULT_ERROR]]')['id'], ['blocked'])
    check(re_['runs'][-1]['status'] == 'failed', 'is_error with exit 0 counts as a failure')


@scenario
def flow_codex_runtime():
    ws = workspace('Codex')
    i = issue(ws, 'Codex', 'do it', agent=False, agentId=CX['id'])
    d = settled(i['id'], ['in_review'])
    r = d['runs'][-1]
    check(r['runtime'] == 'codex' and r['status'] == 'succeeded', 'the Codex runtime goes through the same flow')
    check(r['inputTokens'] == 60 and r['cachedTokens'] == 40 and r['outputTokens'] == 7, 'Codex tokens: input without cache, cache and output')
    check(any(c['kind'] == 'agent' and 'Codex finished' in c['body'] for c in d['comments']), "Codex's final message becomes a comment")
    args = run_args(i['id'])
    check('-m\no4-test' in args and 'model_reasoning_effort="high"' in args, 'Codex receives model and effort')
    check(args.endswith('-') and 'exec' in args and '--json' in args, 'Codex reads the prompt from stdin in JSON mode')
    check('Follow the house style' in sh(f'cat {dbg(i["id"])}/last-prompt.txt'), "Codex has no system prompt: the instructions go at the start")
    f = settled(issue(ws, 'Codex fail', '[[CODEX_FAIL]]', agent=False, agentId=CX['id'])['id'], ['blocked'])
    check(f['runs'][-1]['status'] == 'failed', 'a Codex failure goes to Blocked')


@scenario
def flow_agent_configuration_reaches_the_cli():
    ws = workspace('Config')
    sk_all = ok(own('POST', '/skills', {'name': f'Always {seq["n"]}', 'description': 'd', 'content': 'always body', 'always': True}))
    sk = ok(own('POST', '/skills', {'name': f'Deploy {seq["n"]}', 'description': 'how to deploy', 'content': 'deploy body',
                                    'files': [{'path': 'run.sh', 'content': '#!/bin/sh\necho hi\n'}, {'path': '../../../../escape.txt', 'content': 'x'}]}))
    ag = ok(own('POST', '/agents', {'name': 'Tuned', 'runtime': 'claude', 'model': 'sonnet', 'effort': 'high', 'maxBudgetUsd': 2.5,
                                    'instructions': 'Follow the rules', 'skillIds': [sk['id']], 'extraArgs': '--foo "a b" --bar'}))
    i = issue(ws, 'Cfg', '[[WRITE:x.txt]]', agent=False, agentId=ag['id'])
    settled(i['id'], ['in_review'])
    args = run_args(i['id']).split('\n')
    check(args[args.index('--model') + 1] == 'sonnet' and args[args.index('--effort') + 1] == 'high' and args[args.index('--max-budget-usd') + 1] == '2.50', 'model, effort and budget reach the CLI')
    check('a b' in args and '--bar' in args, 'extra arguments respect the quotes')
    sys_ = args[args.index('--append-system-prompt') + 1:]
    joined = '\n'.join(sys_)
    check('Follow the rules' in joined and 'SKILL.md' in joined, 'instructions and the skill index go in the system prompt')
    check(sk['slug'] in joined and sk_all['slug'] in joined, 'the agent bundle and the "attach to all" skill are in the index')
    check('deploy body' not in joined, 'the prompt carries only the index, not the body of the skill')
    check('deploy body' in sh(f'cat /data/skills/{sk["slug"]}/SKILL.md'), 'the whole skill is on disk')
    check(sh(f'test -x /data/skills/{sk["slug"]}/run.sh && echo yes') == 'yes', 'scripts with a shebang are executable')
    check(sh('find /data -maxdepth 2 -name escape.txt; ls /escape.txt 2>/dev/null') == '', 'a skill file path cannot escape its folder')
    env = sh(f'cat {dbg(i["id"])}/last-env.txt')
    check('DATABASE_URL' not in env, "the database URL does not reach the agent's environment")
    check('FOREMAN_ISSUE=' + ws['key'] in env and 'GOCACHE=/data/cache' in env, 'the agent gets FOREMAN_* and the package cache')
    ok(own('DELETE', f'/skills/{sk_all["id"]}'))


@scenario
def flow_multi_repo_scope():
    ws = workspace('Multi', repos=('api', 'web'))
    i = settled(issue(ws, 'Both', '[[WRITE:api/a.txt]][[WRITE:web/w.txt]]')['id'], ['in_review'])
    rep = {r['name']: r for r in i['issue']['repos']}
    check(rep['api']['changed'] and rep['web']['changed'], 'the agent changed both repositories')
    prompt = sh(f'cat {dbg(i["issue"]["id"])}/last-prompt.txt')
    check('the api repository' in prompt and 'the web repository' in prompt, 'the prompt has the repository map')
    one = settled(issue(ws, 'One', '[[WRITE:web/only.txt]]')['id'], ['in_review'])
    rep = {r['name']: r for r in one['issue']['repos']}
    check(not rep['api']['changed'] and rep['web']['changed'], 'only the touched repository is marked')
    check(not has_ref(ws['remotes']['api'], one['issue']['branch']), 'the untouched repository got no branch')
    ok(own('POST', f'/issues/{one["issue"]["id"]}/approve'))
    settled(one['issue']['id'], ['done'])
    check(sh('ls /data/tmp 2>/dev/null') == '', 'after the merge no temporary folder is left, not even of the untouched repository')


# ======================================================================
# Stopping and the queue
# ======================================================================

@scenario
def queue_respects_the_parallel_limit():
    ws = workspace('Queue')
    ids = [issue(ws, f'Q{n}', '[[SLEEP:4]][[WRITE:q.txt]]')['id'] for n in range(6)]
    peak = 0
    end = time.time() + 40
    while time.time() < end:
        # One query, so the count is a single moment (reading issue by issue, a run that ends and
        # the next one that starts in between would both look running).
        idl = ','.join(f"'{x}'" for x in ids)
        running, done = map(int, psql(f"select count(*) filter (where status = 'running'), count(*) filter (where status = 'succeeded') from runs where issue_id in ({idl})").split('|'))
        peak = max(peak, running)
        if done == 6:
            break
        time.sleep(0.2)
    check(peak == 3, f'at most FOREMAN_MAX_PARALLEL running at once (peak {peak})')
    check(all(status(x) == 'in_review' for x in [settled(x)['issue']['id'] for x in ids]), 'everything in the queue finished and went to In review')


@scenario
def stopping_a_running_agent():
    ws = workspace('Stop')
    i = issue(ws, 'Stop', '[[SLEEP:3101]]')
    wait_until(lambda: 'sleep 3101' in dc('top', 'foreman').stdout, 15)
    check('sleep 3101' in dc('top', 'foreman').stdout, 'the agent is running')
    ok(own('POST', f'/issues/{i["id"]}/cancel'))
    d = settled(i['id'], ['backlog'], 20)
    check(d['runs'][-1]['status'] == 'cancelled', 'cancel stops the run and goes to Backlog')
    check(wait_until(lambda: 'sleep 3101' not in dc('top', 'foreman').stdout, 15), 'the whole process tree died')
    check(own('POST', f'/issues/{i["id"]}/cancel')[0] == 400, 'cancelling with nothing running answers 400')

    j = issue(ws, 'Back', '[[SLEEP:3102]]')
    wait_until(lambda: 'sleep 3102' in dc('top', 'foreman').stdout, 15)
    ok(own('PATCH', f'/issues/{j["id"]}', {'status': 'cancelled'}))
    check(wait_until(lambda: 'sleep 3102' not in dc('top', 'foreman').stdout, 15), 'moving to Cancelled stops the agent')
    d = settled(j['id'], ['cancelled'], 15)
    check(d['issue']['closed'] == 'cancelled', 'Cancelled closes as cancelled, and stays there')


@scenario
def cancelling_a_queued_run_releases_the_issue():
    ws = workspace('CancelQueued')
    fill = [issue(ws, f'Fill{n}', '[[SLEEP:6]][[NO_CHANGES]]')['id'] for n in range(3)]
    wait_until(lambda: sum(r['status'] == 'running' for x in fill for r in detail(x)['runs']) == 3, 15)
    q = issue(ws, 'Queued', '[[NO_CHANGES]]')
    d = wait_until(lambda: (lambda d: d if d['runs'] and d['runs'][-1]['status'] == 'queued' and d['issue']['status'] == 'in_progress' else None)(detail(q['id'])), 5)
    check(d is not None, 'the fourth waits in the queue')
    ok(own('POST', f'/issues/{q["id"]}/cancel'))
    check(wait_until(lambda: status(q['id']) == 'backlog', 5), 'cancelling while queued goes to Backlog like a running cancel (does not stay In progress forever)')
    for x in fill:
        settled(x)


@scenario
def double_click_never_runs_twice():
    ws = workspace('Double')
    i = issue(ws, 'Dbl', '[[NO_CHANGES]]', status='backlog')
    with cf.ThreadPoolExecutor(12) as ex:
        res = list(ex.map(lambda _: own('POST', f'/issues/{i["id"]}/run', {}), range(12)))
    codes = sorted(r[0] for r in res)
    settled(i['id'], None, 30)
    runs = detail(i['id'])['runs']
    check(len(runs) == 1, f'12 simultaneous requests create 1 run ({len(runs)} created, answers {codes})')
    check(500 not in codes, 'and nobody gets a 500')


@scenario
def deleting_a_running_issue():
    ws = workspace('Del')
    i = issue(ws, 'Del', '[[SLEEP:3103]]')
    wait_until(lambda: 'sleep 3103' in dc('top', 'foreman').stdout, 15)
    ok(own('DELETE', f'/issues/{i["id"]}'))
    check(wait_until(lambda: 'sleep 3103' not in dc('top', 'foreman').stdout, 15), 'deleting kills the agent')
    check(own('GET', f'/issues/{i["id"]}')[0] == 404 and healthy(), 'the issue is gone and the server is fine')
    check(wait_until(lambda: sh('ls /data/tmp 2>/dev/null') == '', 10), "the run's temporary folder is gone")


@scenario
def deleting_a_workspace_with_a_run():
    ws = workspace('DelWs')
    i = issue(ws, 'X', '[[SLEEP:3104]]')
    wait_until(lambda: 'sleep 3104' in dc('top', 'foreman').stdout, 15)
    ok(own('DELETE', f'/workspaces/{ws["id"]}/'))
    check(healthy() and own('GET', f'/issues/{i["id"]}')[0] == 404, 'removing the workspace mid-run does not bring the server down')
    check(wait_until(lambda: 'sleep 3104' not in dc('top', 'foreman').stdout, 20), "the deleted workspace's agent does not keep running")


@scenario
def fast_failures_do_not_get_stuck():
    # The "agent started" and "run finished" rules run in parallel: an agent that dies at
    # once could finish before the move to In progress and be left there for good.
    ws = workspace('Race')
    ids = [issue(ws, f'R{n}', '[[EXIT:1]]')['id'] for n in range(15)]
    for x in ids:
        wait_until(lambda: not detail(x)['issue']['activeRun'], 30)
    time.sleep(2)
    st = [status(x) for x in ids]
    check(all(s == 'blocked' for s in st), f'all 15 immediate failures in Blocked: {dict((s, st.count(s)) for s in set(st))}')


@scenario
def hung_agent_output_and_timeout():
    ws = workspace('Hang')
    i = issue(ws, 'Huge', '[[HUGE_LINE]][[WRITE:h.txt]]')
    d = wait_until(lambda: (lambda d: d if d['runs'] and not d['issue']['activeRun'] else None)(detail(i['id'])), 60)
    check(d is not None, 'a 40 MB stdout line does not freeze the run')
    t = issue(ws, 'Forever', '[[SLEEP:3105]]')
    d = wait_until(lambda: (lambda d: d if d['runs'] and not d['issue']['activeRun'] else None)(detail(t['id'])), 70)
    check(d is not None and d['runs'][-1]['status'] == 'failed' and 'time' in d['runs'][-1]['error'].lower(), 'a run over FOREMAN_RUN_TIMEOUT is killed and fails with a reason')
    check(wait_until(lambda: 'sleep 3105' not in dc('top', 'foreman').stdout, 15), 'the timeout kills the process tree')
    if d:
        settled(t['id'], ['blocked'], 10)
    # Something the agent left running holds stdout: the run still ends, and it goes too.
    bg = issue(ws, 'Dev server', '[[BACKGROUND:3110]][[WRITE:b.txt]]')
    d = settled(bg['id'], ['in_review'], 40)
    check(d['runs'][-1]['status'] == 'succeeded', 'an agent that leaves a dev server running finishes normally')
    check(wait_until(lambda: 'sleep 3110' not in dc('top', 'foreman').stdout, 30), 'and what it left running does not stay alive')
    n = settled(issue(ws, 'Nul', '[[NUL]]')['id'], ['in_review'])
    check(any('before' in c['body'] and 'after' in c['body'] for c in n['comments']), 'a NUL byte in the answer does not lose the comment')


# ======================================================================
# Approval
# ======================================================================

@scenario
def approval_cannot_be_skipped_by_dragging():
    ws = workspace('Skip')
    mem = login('mem@x.com')
    i = to_review(ws)
    st, body = mem('PATCH', f'/issues/{i["id"]}', {'status': 'done'})
    check(st == 403, f'without approval, a Member cannot drag from In review to Done ({st})')
    time.sleep(1)
    check(status(i['id']) == 'in_review' and show(ws['remotes']['api'], 'work.txt') == '', 'and nothing reached main')
    check(mem('PATCH', f'/issues/{i["id"]}', {'status': 'blocked'})[0] == 200, 'other stages stay open')
    st, _ = mem('PATCH', f'/issues/{i["id"]}', {'status': 'done'})
    check(st == 403, f'nor by going around through another stage ({st})')
    time.sleep(1)
    check(show(ws['remotes']['api'], 'work.txt') == '', 'main is still untouched')
    # An issue without code has nothing to protect: the manual path stays free.
    m = issue(ws, 'Manual', agent=False, who=mem)
    check(mem('PATCH', f'/issues/{m["id"]}', {'status': 'done'})[0] == 200, 'an issue without pending code can go to Done by hand')
    # The owner goes through everything.
    j = to_review(ws, 'Owner path')
    check(own('PATCH', f'/issues/{j["id"]}', {'status': 'done'})[0] == 200, 'the owner goes through')


@scenario
def approval_cannot_be_skipped_by_the_merge_button():
    ws = workspace('SkipMerge')
    mem = login('mem@x.com')
    i = to_review(ws)
    st, _ = mem('POST', f'/issues/{i["id"]}/merge', {})
    check(st == 403, f'without approval, the merge button refuses a Member ({st})')
    check(show(ws['remotes']['api'], 'work.txt') == '', 'and nothing reached main')
    ok(mem('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'])
    check(show(ws['remotes']['api'], 'work.txt') != '', 'approving merges normally')


@scenario
def approval_is_for_the_code_that_was_reviewed():
    ws = workspace('Stale', members=('mem', 'rev'))
    ok(own('DELETE', f'/rules/{next(r["id"] for r in rules(ws) if r["action"] == "approval")}'))
    add_rule(ws, 'access', 'approval', {'approvals': 2, 'to': 'done'}, stage='in_review')
    mem, other = login('mem@x.com'), login('rev@x.com')
    i = to_review(ws)
    r = ok(mem('POST', f'/issues/{i["id"]}/approve'))
    check(r['approvals'] == 1 and r['issue']['status'] == 'in_review', 'first of two approvals')
    r = mem('POST', f'/issues/{i["id"]}/approve')
    check(ok(r)['approvals'] == 1 and ok(r)['issue']['status'] == 'in_review', 'the same person approving twice counts once')
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'new code [[WRITE:more.txt]]', 'sendToAgent': True}))
    d = settled(i['id'], ['in_review'])
    check(d['issue']['approvals'] == [], 'new code from the agent clears the previous approvals')
    check(detail(i['id'], mem)['caps']['approve'], 'and whoever approved can approve again')
    ok(mem('POST', f'/issues/{i["id"]}/approve'))
    r = ok(other('POST', f'/issues/{i["id"]}/approve'))
    check(r['approvals'] == 2 and r['issue']['status'] == 'done', 'two different people on the current code move it on')
    settled(i['id'], ['done'])


@scenario
def approval_again_after_a_conflict():
    ws = workspace('ReApprove')
    remote = ws['remotes']['api']
    mem = login('mem@x.com')
    p = to_review(ws, 'P', '[[RESOLVE:version P]]')
    q = to_review(ws, 'Q', '[[RESOLVE:version Q]]')
    ok(own('POST', f'/issues/{p["id"]}/approve'))
    settled(p['id'], ['done'])
    ok(mem('POST', f'/issues/{q["id"]}/approve'))
    d = settled(q['id'], ['blocked'], 15)
    check(d['issue']['repos'][0]['conflict'], 'approved, the merge conflicts and goes to Blocked')
    psql(f"update issues set description = '[[RESOLVE:both]]' where id = '{q['id']}'")
    ok(mem('POST', f'/issues/{q["id"]}/run', {'kind': 'conflict'}))
    d = settled(q['id'], ['in_review'])
    check(not d['issue']['repos'][0]['conflict'], 'the AI resolved it, back to In review')
    d = detail(q['id'], mem)
    check(d['caps']['approve'], 'whoever approved before can approve the resolved version (the button is not stuck)')
    r = ok(mem('POST', f'/issues/{q["id"]}/approve'))
    check(r['issue']['status'] == 'done', 'approving moves on')
    settled(q['id'], ['done'])
    check(show(remote, 'conf.txt') == 'both', 'the resolved version reached main')


@scenario
def approval_respects_the_destination():
    ws = workspace('Dest')
    qa = add_stage(ws, 'QA', 'in_review')
    add_rule(ws, 'access', 'wip', {'wip': 1}, stage=qa['id'])
    add_rule(ws, 'access', 'require', {'requires': ['assignee']}, stage=qa['id'])
    ok(own('DELETE', f'/rules/{next(r["id"] for r in rules(ws) if r["action"] == "approval")}'))
    add_rule(ws, 'access', 'approval', {'approvals': 1, 'to': qa['id']}, stage='in_review')
    mem = login('mem@x.com')
    i = to_review(ws)
    st, body = mem('POST', f'/issues/{i["id"]}/approve')
    check(st == 400 and 'assignee' in body.get('error', ''), f"approving can't skip the destination's requirements ({st} {body.get('error')})")
    check(detail(i['id'])['issue']['approvals'] == [], 'and the refused approval is not recorded')
    ok(own('PATCH', f'/issues/{i["id"]}', {'assigneeId': U['mem']['id']}))
    ok(mem('POST', f'/issues/{i["id"]}/approve'))
    check(status(i['id']) == qa['id'], 'with the requirement met, it moves on')


@scenario
def approval_with_restricted_approvers():
    ws = workspace('Who', members=('mem', 'rev'))
    ok(own('DELETE', f'/rules/{next(r["id"] for r in rules(ws) if r["action"] == "approval")}'))
    add_rule(ws, 'access', 'approval', {'approvals': 1, 'to': 'done', 'users': [U['rev']['id']]}, stage='in_review')
    i = to_review(ws)
    mem, rev = login('mem@x.com'), login('rev@x.com')
    check(mem('POST', f'/issues/{i["id"]}/approve')[0] == 403, 'whoever is not listed cannot approve')
    check(not detail(i['id'], mem)['caps']['approve'] and detail(i['id'], rev)['caps']['approve'], 'caps say who can')
    ok(rev('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'])


# ======================================================================
# Merge
# ======================================================================

@scenario
def adjusting_after_the_merge():
    # Reopening a merged issue: the new changes need to reach main too.
    ws = workspace('Reopen')
    remote = ws['remotes']['api']
    i = to_review(ws, 'First', '[[WRITE:first.txt]]')
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'])
    check(wait_until(lambda: show(remote, 'first.txt') != '', 10), 'the first version is on main')
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'also add this [[WRITE:second.txt]]', 'sendToAgent': True}))
    d = settled(i['id'], ['in_review'])
    check(d['issue']['closed'] == '' and d['issue']['doneAt'] is None, 'reopening clears the "resolved" mark')
    r = d['issue']['repos'][0]
    check(r['changed'] and r['mergedInto'] == '', 'the repository is pending merge again')
    check(show(remote, 'second.txt', d['issue']['branch']) != '', 'the new branch was published')
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'])
    check(wait_until(lambda: show(remote, 'second.txt') != '', 10), 'the adjustment reaches main (not left behind on a done issue)')
    check(show(remote, 'first.txt') != '', 'the first version is still there')
    check(detail(i['id'])['issue']['repos'][0]['mergedInto'] == 'main', 'the issue says merged again')


@scenario
def two_merges_at_once():
    ws = workspace('Merge2')
    i = to_review(ws, 'M')
    with cf.ThreadPoolExecutor(4) as ex:
        res = list(ex.map(lambda _: own('POST', f'/issues/{i["id"]}/merge', {}), range(4)))
    codes = sorted(r[0] for r in res)
    check(500 not in codes and 200 in codes, f'simultaneous merges: one wins, nobody gets a 500 ({codes})')
    d = settled(i['id'], ['done'], 15)
    time.sleep(1)
    check(status(i['id']) == 'done' and d['issue']['repos'][0]['mergedInto'] == 'main', f'the issue ends in Done, not Blocked ({status(i["id"])})')


@scenario
def merge_conflict_stages():
    ws = workspace('Conflict')
    remote = ws['remotes']['api']
    p = to_review(ws, 'P', '[[RESOLVE:version P]]')
    q = to_review(ws, 'Q', '[[RESOLVE:version Q]]')
    ok(own('POST', f'/issues/{p["id"]}/approve'))
    settled(p['id'], ['done'])
    ok(own('POST', f'/issues/{q["id"]}/approve'))
    d = settled(q['id'], ['blocked'], 15)
    before = rg(remote, 'rev-parse', 'main')
    check(d['issue']['repos'][0]['conflict'] and any('conf.txt' in c['body'] for c in d['comments']), 'conflict: Blocked, with the files')
    ok(own('POST', f'/issues/{q["id"]}/run', {'kind': 'conflict'}))
    d = settled(q['id'], ['blocked', 'in_review'], 20)
    ok(own('POST', f'/issues/{q["id"]}/comments', {'body': 'fix it [[RESOLVE:both sides]]', 'sendToAgent': True}))
    d = settled(q['id'], ['in_review', 'blocked'], 20)
    check(d['issue']['status'] == 'in_review' and d['runs'][-1]['status'] == 'succeeded', f'a normal adjustment can finish the conflict that was left open ({d["runs"][-1]["error"]})')
    ok(own('POST', f'/issues/{q["id"]}/approve'))
    settled(q['id'], ['done'], 15)
    check(show(remote, 'conf.txt') == 'both sides', 'the resolution reaches main')
    check(rg(remote, 'rev-parse', 'main') != before, 'main moved forward')


@scenario
def markers_left_behind_never_reach_main():
    ws = workspace('Markers')
    remote = ws['remotes']['api']
    p = to_review(ws, 'P', '[[RESOLVE:version P]]')
    q = to_review(ws, 'Q', '[[RESOLVE:version Q]]')
    ok(own('POST', f'/issues/{p["id"]}/approve'))
    settled(p['id'], ['done'])
    ok(own('POST', f'/issues/{q["id"]}/approve'))
    settled(q['id'], ['blocked'], 15)
    # The agent ran but did not touch the conflicted file.
    psql(f"update issues set description = '[[KEEP_MARKERS]]' where id = '{q['id']}'")
    ok(own('POST', f'/issues/{q["id"]}/run', {'kind': 'conflict'}))
    d = settled(q['id'], ['blocked'], 20)
    check(d['runs'][-1]['status'] == 'failed' and 'conflict markers' in d['runs'][-1]['error'], 'the agent left conflict markers: the run fails and says so')
    check(d['issue']['repos'][0]['conflict'], 'the issue stays marked as in conflict')
    check('<<<<' not in show(remote, 'conf.txt') and '<<<<' not in show(remote, 'conf.txt', d['issue']['branch']), 'no marker reached the remote')
    psql(f"update issues set description = '[[RESOLVE:clean]]' where id = '{q['id']}'")
    ok(own('POST', f'/issues/{q["id"]}/run', {'kind': 'conflict'}))
    d = settled(q['id'], ['in_review', 'blocked'], 20)
    check(d['issue']['status'] == 'in_review', f'trying again resumes the merge and resolves it ({d["runs"][-1]["error"]})')
    ok(own('POST', f'/issues/{q["id"]}/approve'))
    settled(q['id'], ['done'], 15)
    check(show(remote, 'conf.txt') == 'clean', 'and it reaches main')


@scenario
def base_moved_without_conflict():
    ws = workspace('Moved')
    remote = ws['remotes']['api']
    i = to_review(ws, 'A', '[[WRITE:a.txt]]')
    with tempfile.TemporaryDirectory() as d:
        git('clone', '-q', f'{REM}/{remote}.git', d)
        open(d + '/human.txt', 'w').write('human\n')
        git('add', '.', cwd=d)
        git('-c', 'user.name=h', '-c', 'user.email=h@h', 'commit', '-qm', 'human', cwd=d)
        git('push', '-q', 'origin', 'main', cwd=d)
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'], 15)
    check(show(remote, 'human.txt') != '' and show(remote, 'a.txt') != '', "the merge lands on top of what others pushed")


@scenario
def other_default_branches_and_targets():
    ws = workspace('Dev', default='develop')
    remote = ws['remotes']['api']
    i = to_review(ws, 'D', '[[WRITE:d.txt]]')
    r = i['repos'][0]
    check(r['baseBranch'] == 'develop' and r['targetBranch'] == 'develop', "the base is the remote's default branch")
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'], 15)
    check(show(remote, 'd.txt', 'develop') != '' and not has_ref(remote, 'refs/heads/main'), 'the merge lands on develop')
    j = issue(ws, 'H', '[[WRITE:h.txt]]', status='backlog')
    ok(own('PUT', f'/issues/{j["id"]}/repos', {'all': False, 'repos': [{'repoId': ws['repos']['api']['id'], 'baseBranch': 'release', 'targetBranch': 'release'}]}))
    ok(own('POST', f'/issues/{j["id"]}/run', {}))
    settled(j['id'], ['in_review'])
    ok(own('POST', f'/issues/{j["id"]}/approve'))
    settled(j['id'], ['done'], 15)
    check(show(remote, 'h.txt', 'release') != '' and show(remote, 'h.txt', 'develop') == '', 'a chosen branch: base and merge on release only')
    k = to_review(ws, 'T', '[[WRITE:t.txt]]')
    st, body = own('POST', f'/issues/{k["id"]}/merge', {'targets': {ws['repos']['api']['id']: 'nope'}})
    check(st == 400 and 'nope' in body['error'], 'a merge to a branch that does not exist is refused')
    br = ok(own('GET', f'/repos/{ws["repos"]["api"]["id"]}/branches'))
    check('develop' in br and 'release' in br and not any(b.startswith('fm/') for b in br), f'the branch picker hides issue branches: {br}')


@scenario
def working_branch_is_picked_from_the_remote():
    ws = workspace('Pick', repos=())
    remote = new_remote('pick', 'main', branches=('release', 'dev'))
    url = f'file:///remote/{remote}.git'
    got = ok(own('POST', f'/workspaces/{ws["id"]}/repos/check', {'url': url}))
    check(got['branches'] == ['dev', 'main', 'release'] and got['default'] == 'main', f'the connection test lists the remote branches and its default: {got}')
    st, body = own('POST', f'/workspaces/{ws["id"]}/repos/check', {'url': 'file:///remote/nothing-here.git'})
    check(st == 400 and 'not a git repository' in body['error'], 'the connection test refuses a URL that is not a reachable repository')
    st, body = login('mem@x.com')('POST', f'/workspaces/{ws["id"]}/repos/check', {'url': url})
    check(st == 403, 'whoever cannot add or edit repositories cannot test URLs')
    st, body = own('POST', f'/workspaces/{ws["id"]}/repos', {'url': url, 'name': 'app'})
    check(st == 400 and 'working branch' in body['error'], 'a repository without a working branch is refused: ' + body.get('error', '')[:60])
    st, body = own('POST', f'/workspaces/{ws["id"]}/repos', {'url': url, 'name': 'app', 'workBranch': 'typed-by-hand'})
    check(st == 400 and 'typed-by-hand' in body['error'], 'a branch that does not exist on the remote is refused')
    repo = ok(own('POST', f'/workspaces/{ws["id"]}/repos', {'url': url, 'name': 'app', 'workBranch': 'dev'}))
    check(repo['workBranch'] == 'dev', 'the picked branch is saved')
    i = to_review(ws, 'P', '[[WRITE:p.txt]]')
    r = i['repos'][0]
    check(r['baseBranch'] == 'dev' and r['targetBranch'] == 'dev', f"the issue starts from the working branch, not the remote's default: {r['baseBranch']}/{r['targetBranch']}")
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'], 15)
    check(show(remote, 'p.txt', 'dev') != '' and show(remote, 'p.txt', 'main') == '', 'the merge lands on the working branch and main stays untouched')
    st, _ = own('PUT', f'/repos/{repo["id"]}', {'url': repo['url'], 'name': 'app', 'workBranch': 'gone'})
    check(st == 400 and psql(f"select work_branch from repos where id = '{repo['id']}'") == 'dev', 'editing to a branch that does not exist is refused and keeps the old one')


@scenario
def protected_target_branch():
    # A real server (protected branch): the push is refused and nothing can be lost.
    ws = workspace('Protected')
    remote = ws['remotes']['api']
    set_hook(remote, 'while read o n r; do [ "$r" = refs/heads/main ] && { echo "protected branch"; exit 1; }; done; exit 0')
    i = to_review(ws, 'P', '[[WRITE:p.txt]]')
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    d = settled(i['id'], ['blocked'], 15)
    check(any('protected branch' in c['body'] or 'push' in c['body'] for c in d['comments']), 'the refused push goes to Blocked and says why')
    check(has_ref(remote, d['issue']['branch']) and not d['issue']['repos'][0]['mergedInto'], 'the issue branch stays, nothing marked as merged')
    set_hook(remote, None)
    ok(own('POST', f'/issues/{i["id"]}/merge', {}))
    d = settled(i['id'], ['done'], 15)
    check(show(remote, 'p.txt') != '', 'without the protection, trying again works')


@scenario
def partial_push_with_several_repositories():
    ws = workspace('Partial', repos=('api', 'web'))
    web = ws['remotes']['web']
    set_hook(web, 'while read o n r; do [ "$r" = refs/heads/main ] && { echo "web frozen"; exit 1; }; done; exit 0')
    i = to_review(ws, 'Both', '[[WRITE:api/a.txt]][[WRITE:web/w.txt]]')
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    d = settled(i['id'], ['blocked'], 15)
    check(any('web frozen' in c['body'] or 'pushing' in c['body'] for c in d['comments']), 'one repository refused: Blocked, saying which')
    set_hook(web, None)
    ok(own('POST', f'/issues/{i["id"]}/merge', {}))
    settled(i['id'], ['done'], 15)
    rep = {r['name']: r for r in detail(i['id'])['issue']['repos']}
    check(rep['api']['mergedInto'] == 'main' and rep['web']['mergedInto'] == 'main', 'trying again finishes the remaining one')
    check(show(ws['remotes']['api'], 'a.txt') != '' and show(web, 'w.txt') != '', 'both have the change on main')


@scenario
def human_commits_on_the_issue_branch_survive():
    # Someone pushes a fix directly to the fm/ branch; the next run can't wipe it.
    ws = workspace('Human')
    remote = ws['remotes']['api']
    i = to_review(ws, 'H', '[[WRITE:a.txt]]')
    br = i['branch']
    with tempfile.TemporaryDirectory() as d:
        git('clone', '-q', '-b', br, f'{REM}/{remote}.git', d)
        open(d + '/human-fix.txt', 'w').write('fix\n')
        git('add', '.', cwd=d)
        git('-c', 'user.name=h', '-c', 'user.email=h@h', 'commit', '-qm', 'human fix', cwd=d)
        git('push', '-q', 'origin', br, cwd=d)
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'one more [[WRITE:b.txt]]', 'sendToAgent': True}))
    d = settled(i['id'], ['in_review', 'blocked'])
    check(d['issue']['status'] == 'in_review', f'the run went fine ({d["runs"][-1]["error"]})')
    check(show(remote, 'human-fix.txt', br) != '', "the human commit is still on the remote branch")
    check(show(remote, 'b.txt', br) != '', "and the agent's change is there too")


@scenario
def every_request_gets_a_new_temporary_folder():
    ws = workspace('Temp')
    remote = ws['remotes']['api']
    i = to_review(ws, 'T', '[[WRITE:a.txt]]')
    check(sh('find /data/tmp /data/worktrees /data/issues -mindepth 1 2>/dev/null') == '', 'the run left no folder behind (no worktree, no issue folder)')
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'more [[WRITE:b.txt]]', 'sendToAgent': True}))
    d = settled(i['id'], ['in_review'], 20)
    br = d['issue']['branch']
    check(show(remote, 'a.txt', br) != '' and show(remote, 'b.txt', br) != '', 'the second request starts from the branch, with the first one\'s work')
    prompts = [e['body'] for r in d['runs'] for e in ok(own('GET', f'/runs/{r["id"]}/events')) if e['kind'] == 'prompt']
    roots = {l.split('`')[1] for p in prompts for l in p.splitlines() if 'isolated git worktree' in l}
    check(len(roots) == 2 and all(r.startswith('/data/tmp/run-') for r in roots), f'each request ran in its own temporary folder: {roots}')
    check(sh('ls /data/tmp 2>/dev/null') == '', 'and both were removed')


@scenario
def repository_problems():
    ws = workspace('Probl', repos=())
    remote = new_remote('empty')
    with tempfile.TemporaryDirectory() as d:
        git('init', '-q', '--bare', '-b', 'main', f'{d}/e.git')
        subprocess.run(['cp', '-r', f'{d}/e.git', f'{REM}/empty-real.git'])
    st, body = own('POST', f'/workspaces/{ws["id"]}/repos/check', {'url': 'file:///remote/empty-real.git'})
    check(st == 400 and 'empty' in body['error'], 'an empty remote has no branch to pick and says it is empty: ' + body.get('error', '')[:80])
    st, _ = own('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file:///remote/empty-real.git', 'name': 'empty', 'workBranch': 'main'})
    check(st == 400, 'and it cannot be saved')

    gone = workspace('Gone')
    i = to_review(gone, 'G', '[[WRITE:a.txt]]')
    subprocess.run(['mv', f'{REM}/{gone["remotes"]["api"]}.git', f'{REM}/moved.git'])
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'more', 'sendToAgent': True}))
    d = settled(i['id'], ['blocked'], 15)
    check(d['runs'][-1]['status'] == 'failed', 'a remote that vanished fails the run, it does not hang')
    subprocess.run(['mv', f'{REM}/moved.git', f'{REM}/{gone["remotes"]["api"]}.git'])
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'again [[WRITE:b.txt]]', 'sendToAgent': True}))
    d = settled(i['id'], ['in_review', 'blocked'], 20)
    br = d['issue']['branch']
    check(d['issue']['status'] == 'in_review' and show(gone['remotes']['api'], 'a.txt', br) != '', 'the next request starts again from the branch, with the work intact')


# ======================================================================
# Rules
# ======================================================================

@scenario
def rules_triggers_and_actions():
    ws = workspace('Rules')
    mem = login('mem@x.com')
    lab = ok(own('POST', f'/workspaces/{ws["id"]}/labels', {'name': 'vip'}))
    tag = f'tag{seq["n"]}'
    mark = lambda text: {'message': text}
    add_rule(ws, 'created', 'comment', mark(f'{tag}-created'))
    add_rule(ws, 'commented', 'comment', mark(f'{tag}-commented'))
    add_rule(ws, 'assigned', 'comment', mark(f'{tag}-assigned'))
    add_rule(ws, 'priority_changed', 'comment', mark(f'{tag}-priority'))
    add_rule(ws, 'run_started', 'comment', mark(f'{tag}-started'))
    add_rule(ws, 'run_finished', 'comment', mark(f'{tag}-finished-done'), conditions={'outcomes': ['done']})
    add_rule(ws, 'run_finished', 'comment', mark(f'{tag}-finished-failed'), conditions={'outcomes': ['failed']})
    add_rule(ws, 'merged', 'comment', mark(f'{tag}-merged'))
    add_rule(ws, 'leave', 'comment', mark(f'{tag}-left-review'), stage='in_review')
    add_rule(ws, 'enter', 'comment', mark(f'{tag}-off'), stage='in_review', enabled=False)
    add_rule(ws, 'enter', 'comment', mark(f'{tag}-only-vip'), stage='in_review', conditions={'labels': [lab['id']]})
    add_rule(ws, 'enter', 'comment', mark(f'{tag}-only-urgent'), stage='in_review', conditions={'priorities': [1]})
    add_rule(ws, 'enter', 'comment', mark(f'{tag}-this-agent'), stage='in_review', conditions={'agents': [AG['id']]})
    add_rule(ws, 'enter', 'comment', mark(f'{tag}-other-agent'), stage='in_review', conditions={'agents': [CX['id']]})
    add_rule(ws, 'commented', 'comment', mark(f'{tag}-by-owner'), conditions={'actorRoles': [U['admin_role']]})
    add_rule(ws, 'commented', 'comment', mark(f'{tag}-by-member'), conditions={'actorRoles': [U['member_role']]})
    i = issue(ws, 'R', '[[WRITE:a.txt]]', priority=3)
    settled(i['id'], ['in_review'])
    ok(own('PATCH', f'/issues/{i["id"]}', {'priority': 2}))
    ok(own('PATCH', f'/issues/{i["id"]}', {'assigneeId': U['mem']['id']}))
    ok(mem('POST', f'/issues/{i["id"]}/comments', {'body': 'hello'}))
    ok(own('POST', f'/issues/{i["id"]}/approve'))
    settled(i['id'], ['done'], 15)
    wait_until(lambda: has_comment(i['id'], f'{tag}-merged'), 5)
    time.sleep(1)
    cs = comments(i['id'])
    has = lambda t: any(f'{tag}-{t}' in c for c in cs)
    for t in ['created', 'commented', 'assigned', 'priority', 'started', 'finished-done', 'merged', 'left-review', 'this-agent', 'by-member']:
        check(has(t), f'the {t} rule fired')
    for t in ['off', 'only-vip', 'only-urgent', 'other-agent', 'finished-failed', 'by-owner']:
        check(not has(t), f'the {t} rule did not fire')


@scenario
def rules_change_the_issue():
    ws = workspace('Change', members=('mem', 'rev'))
    lab = ok(own('POST', f'/workspaces/{ws["id"]}/labels', {'name': 'auto'}))
    st = add_stage(ws, 'Triage')
    add_rule(ws, 'enter', 'set_priority', {'priority': 1}, stage=st['id'])
    add_rule(ws, 'enter', 'add_label', {'labelId': lab['id']}, stage=st['id'])
    add_rule(ws, 'enter', 'set_agent', {'agentId': CX['id']}, stage=st['id'])
    add_rule(ws, 'enter', 'assign', {'mode': 'user', 'users': [U['mem']['id']]}, stage=st['id'])
    i = issue(ws, 'C', agent=False, status=st['id'])
    d = wait_until(lambda: (lambda d: d if d['issue']['assigneeId'] else None)(detail(i['id'])), 8)
    x = d['issue']
    check(x['priority'] == 1 and x['labelIds'] == [lab['id']] and x['agentId'] == CX['id'] and x['assigneeId'] == U['mem']['id'], 'set priority, label, agent and assignee')
    check(has_comment(i['id'], 'assignee: mem'), 'each action leaves a note on the issue')
    # Balance: whoever has fewer open issues.
    st2 = add_stage(ws, 'Round')
    add_rule(ws, 'enter', 'assign', {'mode': 'balance', 'users': [U['mem']['id'], U['rev']['id']]}, stage=st2['id'])
    j = issue(ws, 'J', agent=False, status=st2['id'])
    check(wait_until(lambda: detail(j['id'])['issue']['assigneeId'] == U['rev']['id'], 8), 'balance goes to whoever has fewer open issues')
    st3 = add_stage(ws, 'Creator')
    add_rule(ws, 'enter', 'assign', {'mode': 'creator'}, stage=st3['id'])
    k = issue(ws, 'K', agent=False, status=st3['id'], who=login('mem@x.com'))
    check(wait_until(lambda: detail(k['id'])['issue']['assigneeId'] == U['mem']['id'], 8), 'assign to whoever created')


@scenario
def rule_sequence_with_scripts_and_failures():
    ws = workspace('Seq')
    tag = 'seq-' + ws['key']
    fail_stage = add_stage(ws, 'FailedHere')
    st = add_stage(ws, 'Pipeline')
    add_rule(ws, 'enter', 'script', {'script': 'echo "$FOREMAN_ISSUE|$FOREMAN_TITLE|$FOREMAN_STAGE|$FOREMAN_FROM|$FOREMAN_EVENT|$FOREMAN_WORKSPACE|$FOREMAN_PRIORITY"; pwd'}, stage=st['id'])
    add_rule(ws, 'enter', 'script', {'script': f'echo {tag}-bad; exit 3', 'onFail': fail_stage['id']}, stage=st['id'])
    add_rule(ws, 'enter', 'comment', {'message': f'{tag}-after'}, stage=st['id'])
    i = issue(ws, 'S', agent=False, status='backlog', priority=2)
    ok(own('PATCH', f'/issues/{i["id"]}', {'status': st['id']}))
    check(wait_until(lambda: status(i['id']) == fail_stage['id'], 10), 'a failing script with "if it fails, move to" goes there')
    cs = comments(i['id'])
    check(any(f'{ws["key"]}-{i["number"]}|S|{st["id"]}|backlog|stage|{ws["key"]}|2' in c for c in cs), 'the script receives every FOREMAN_* variable')
    check(any(f'{tag}-bad' in c and 'failed' in c for c in cs), "the failure's output shows on the issue")
    check(not any(f'{tag}-after' in c for c in cs), 'the rules after the failure do not run')
    # No "if it fails": the "A rule failed" rule decides.
    st2 = add_stage(ws, 'Pipe2')
    add_rule(ws, 'enter', 'script', {'script': 'exit 1'}, stage=st2['id'])
    j = issue(ws, 'T', agent=False, status='backlog')
    ok(own('PATCH', f'/issues/{j["id"]}', {'status': st2['id']}))
    check(wait_until(lambda: status(j['id']) == 'blocked', 10), 'without its own destination, a rule failed → Blocked')
    # Open PR on something that is not GitHub.
    st3 = add_stage(ws, 'PR')
    add_rule(ws, 'enter', 'open_pr', {}, stage=st3['id'])
    k = to_review(ws, 'PR', '[[WRITE:a.txt]]')
    ok(own('PATCH', f'/issues/{k["id"]}', {'status': st3['id']}))
    check(wait_until(lambda: status(k['id']) == 'blocked', 10) and has_comment(k['id'], 'GitHub'), 'opening a PR off GitHub fails with a clear reason')


@scenario
def agent_step_inside_a_stage():
    ws = workspace('Step')
    tag = 'step-' + ws['key']
    needs, broke = add_stage(ws, 'NeedsSomeone'), add_stage(ws, 'Broke')
    st = add_stage(ws, 'AIReview', 'in_progress')
    add_rule(ws, 'enter', 'comment', {'message': f'{tag}-1'}, stage=st['id'])
    add_rule(ws, 'enter', 'run_agent', {'request': 'review [[SLEEP:2]][[WRITE:r.txt]]', 'wait': True, 'onFail': broke['id'], 'onWaiting': needs['id']}, stage=st['id'])
    add_rule(ws, 'enter', 'comment', {'message': f'{tag}-2'}, stage=st['id'])
    add_rule(ws, 'enter', 'move', {'to': 'in_review'}, stage=st['id'])
    i = issue(ws, 'S', status='backlog')
    ok(own('PATCH', f'/issues/{i["id"]}', {'status': st['id']}))
    check(wait_until(lambda: detail(i['id'])['issue']['activeRun'], 8) and status(i['id']) == st['id'], 'the issue stays in the stage while the agent works')
    settled(i['id'], ['in_review'], 20)
    cs = comments(i['id'])
    check(cs.index(next(c for c in cs if f'{tag}-1' in c)) < cs.index(next(c for c in cs if f'{tag}-2' in c)), 'the rules keep their order around the agent')

    # The person takes the issue out while the step runs: the sequence stops.
    j = issue(ws, 'Leave', status='backlog')
    ok(own('PATCH', f'/issues/{j["id"]}', {'status': st['id']}))
    wait_until(lambda: detail(j['id'])['issue']['activeRun'], 8)
    ok(own('PATCH', f'/issues/{j["id"]}', {'status': 'blocked'}))
    settled(j['id'], None, 20)
    time.sleep(3)
    check(status(j['id']) == 'blocked' and not has_comment(j['id'], f'{tag}-2'), 'taking it out mid-step stops the sequence')

    # Outcomes: the destinations of a failed step and of one needing someone.
    st_f = add_stage(ws, 'StepFail')
    add_rule(ws, 'enter', 'run_agent', {'request': '[[EXIT:2]]', 'wait': True, 'onFail': broke['id']}, stage=st_f['id'])
    k = issue(ws, 'Fail', status='backlog')
    ok(own('PATCH', f'/issues/{k["id"]}', {'status': st_f['id']}))
    check(wait_until(lambda: status(k['id']) == broke['id'], 15), 'a failed step goes to "if it fails"')
    st_w = add_stage(ws, 'StepWait')
    add_rule(ws, 'enter', 'run_agent', {'request': '[[STATUS:waiting: who?]]', 'wait': True, 'onWaiting': needs['id']}, stage=st_w['id'])
    add_rule(ws, 'enter', 'comment', {'message': f'{tag}-never'}, stage=st_w['id'])
    m = issue(ws, 'Wait', status='backlog')
    ok(own('PATCH', f'/issues/{m["id"]}', {'status': st_w['id']}))
    check(wait_until(lambda: status(m['id']) == needs['id'], 15), 'a step that needs someone goes to its destination')
    time.sleep(1)
    check(not has_comment(m['id'], f'{tag}-never'), 'and the following rules do not run')


@scenario
def loops_stop_on_their_own():
    ws = workspace('Loops')
    # An agent that restarts itself would burn money forever.
    add_rule(ws, 'run_finished', 'run_agent', {'request': 'again [[COST:1]][[NO_CHANGES]]'}, conditions={'outcomes': ['done']})
    i = issue(ws, 'Loop', '[[NO_CHANGES]]')
    time.sleep(14)
    n = len(detail(i['id'])['runs'])
    settled(i['id'], None, 15)
    time.sleep(3)
    m = len(detail(i['id'])['runs'])
    check(m <= 6 and n == m or m <= 6, f'"run finished → run agent" does not run forever ({m} runs)')
    check(has_comment(i['id'], 'loop'), 'and the issue says it stopped for that reason')

    # Rules that keep changing a field back and forth.
    w2 = workspace('Loops2')
    add_rule(w2, 'priority_changed', 'set_priority', {'priority': 2}, conditions={'priorities': [1]})
    add_rule(w2, 'priority_changed', 'set_priority', {'priority': 1}, conditions={'priorities': [2]})
    j = issue(w2, 'Flip', agent=False, status='backlog', priority=3)
    ok(own('PATCH', f'/issues/{j["id"]}', {'priority': 1}))
    time.sleep(3)
    a = len(comments(j['id']))
    time.sleep(3)
    b = len(comments(j['id']))
    check(a == b and a < 40, f'rules flipping a field stop ({a} → {b} comments)')


@scenario
def time_based_triggers():
    ws = workspace('Time')
    tag = 'time-' + ws['key']
    add_rule(ws, 'stale', 'comment', {'message': f'{tag}-stale'}, stage='backlog', conditions={'hours': 0.001})
    add_rule(ws, 'cost_over', 'comment', {'message': f'{tag}-cost'}, conditions={'cost': 0.5})
    add_rule(ws, 'stale', 'run_agent', {'request': '[[SLEEP:70]][[NO_CHANGES]]', 'wait': True}, stage='waiting', conditions={'hours': 0.001})
    w = issue(ws, 'Blocks the sweep?', '[[STATUS:waiting: x]][[NO_CHANGES]]')
    settled(w['id'], ['waiting'])
    i = issue(ws, 'Idle', status='backlog', agent=False)
    c = settled(issue(ws, 'Costly', '[[COST:1]][[NO_CHANGES]]')['id'], ['in_review'])
    check(wait_until(lambda: has_comment(c['issue']['id'], f'{tag}-cost'), 70, 2), 'cost above the value fires (minute sweep)')
    check(wait_until(lambda: has_comment(i['id'], f'{tag}-stale'), 80, 2), 'sitting in the stage fires, even with a long agent step on the same sweep')
    time.sleep(62)
    check(sum(f'{tag}-stale' in x for x in comments(i['id'])) == 1, 'and fires only once per stage entry')
    check(sum(f'{tag}-cost' in x for x in comments(c['issue']['id'])) == 1, 'cost fires only once')


@scenario
def external_failures_do_not_stop_the_work():
    ws = workspace('Hooks')
    tag = ws['key'].lower()
    add_rule(ws, 'enter', 'webhook', {'url': f'http://sink:8790/ok/{tag}', 'message': 'hello'}, stage='in_review')
    add_rule(ws, 'enter', 'webhook', {'url': f'http://sink:8790/fail/{tag}'}, stage='in_review')
    add_rule(ws, 'enter', 'comment', {'message': f'{tag}-after-hook'}, stage='in_review')
    i = to_review(ws, 'Hook', '[[WRITE:a.txt]]')
    check(wait_until(lambda: [g for g in get_json(SINK + '/received') if g['path'] == f'/ok/{tag}'], 8), 'the webhook is delivered')
    got = next(g for g in get_json(SINK + '/received') if g['path'] == f'/ok/{tag}')['body']
    check(got['ref'] == f'{ws["key"]}-{i["number"]}' and got['title'] == 'Hook' and got['stage'] == 'In review' and got['message'] == 'hello' and got['event'] == 'issue.stage', 'the webhook carries the issue data')
    check(got['text'] and got['content'], 'with the fields Slack and Discord read')
    check(wait_until(lambda: has_comment(i['id'], 'webhook'), 8), 'the failed webhook leaves a note')
    time.sleep(1.5)
    check(status(i['id']) == 'in_review', f'a webhook that is down does not take the issue to Blocked ({status(i["id"])})')
    check(has_comment(i['id'], f'{tag}-after-hook'), 'and the following rules keep running')


# ---------- e-mail ----------

def mail_settings(**kw):
    return {'enabled': True, 'host': 'mail', 'port': 1025, 'security': 'none', 'from': 'foreman@x.com', 'fromName': 'Foreman', 'appUrl': 'http://fm.test', **kw}


def inbox():
    return get_json(MAIL + '/messages?limit=200')['messages']


def clear_inbox():
    req = urllib.request.Request(MAIL + '/messages', method='DELETE', data=b'{}', headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req, timeout=10).read()


@scenario
def email_flow():
    clear_inbox()
    ws = workspace('Mail', members=('mem', 'rev'))
    optout = make_user(f'quiet{seq["n"]}', U['member_role'], [ws['id']])
    q = login(optout['email'])
    ok(q('PATCH', '/me', {'name': optout['name'], 'emailNotifications': False}))
    outsider = make_user(f'out{seq["n"]}', U['member_role'], [])
    settings = ok(own('PUT', '/settings/email', mail_settings(username='', password='s3cret')))
    check('password' not in settings or not settings.get('password'), 'the password never goes back to the browser')
    check(settings['hasPassword'], 'but the screen knows there is one')
    t = ok(own('POST', '/settings/email/test', mail_settings()))
    check(t['sentTo'] == 'owner@x.com' and wait_until(lambda: any('E-mail test' in m['Subject'] for m in inbox()), 5), 'the test e-mail arrives')
    clear_inbox()

    i = issue(ws, 'Mailed', '[[STATUS:waiting: please decide]][[NO_CHANGES]]', who=login('mem@x.com'))
    def new_issue_mail():
        for x in inbox():
            full = get_json(f'{MAIL}/message/{x["ID"]}')
            if x['Subject'] == f'[Foreman] {ws["name"]}' and 'New issue in' in full['Text']:
                return full
    full = wait_until(new_issue_mail, 8)
    check(full, 'a new issue sends an e-mail with the workspace subject')
    if full:
        bcc = {x['Address'] for x in full.get('Bcc') or []} | {x['Address'] for x in full.get('To') or []}
        check(f'rev@x.com' in bcc and 'owner@x.com' in bcc, f'it reaches the workspace people: {sorted(bcc)}')
        check('mem@x.com' not in bcc, 'not whoever created it')
        check(optout['email'] not in bcc, 'not whoever turned e-mail off')
        check(outsider['email'] not in bcc, 'not who is outside the workspace')
        check(f'w/{ws["key"]}/issues/{ws["key"]}-{i["number"]}' in full['Text'], 'with a link to the issue')
    settled(i['id'], ['waiting'])
    # The default "Waiting, on entry" rule notifies whoever asked.
    def waiting_mail():
        for x in inbox():
            full = get_json(f'{MAIL}/message/{x["ID"]}')
            if 'please decide' in full['Text']:
                return full
    w = wait_until(waiting_mail, 8)
    check(w, 'Waiting e-mails the person, with the question')
    if w:
        check([x['Address'] for x in w.get('Bcc') or []] == ['mem@x.com'] or 'mem@x.com' in json.dumps(w), 'to whoever asked')

    # An SMTP that is down must not stop the work.
    ok(own('PUT', '/settings/email', mail_settings(host='nowhere.invalid', port=2525)))
    j = issue(ws, 'No SMTP', '[[STATUS:waiting: hello]][[NO_CHANGES]]')
    settled(j['id'], ['waiting', 'blocked'], 40)
    time.sleep(2)
    d = settled(j['id'], None, 40)
    check(wait_until(lambda: status(j['id']) == 'waiting', 20), f'an SMTP that is down does not take the issue to Blocked ({status(j["id"])})')
    check(wait_until(lambda: has_comment(j['id'], 'nowhere.invalid'), 25), 'the failure shows as a note on the issue')
    v = ok(own('GET', '/settings/email'))
    check(v['status']['lastError'] != '', 'and on the settings screen')
    # Turned off: sends nothing and says nothing.
    ok(own('PUT', '/settings/email', mail_settings(enabled=False)))
    clear_inbox()
    k = issue(ws, 'Off', '[[STATUS:waiting: x]][[NO_CHANGES]]')
    settled(k['id'], ['waiting'])
    time.sleep(1)
    check(inbox() == [] and not has_comment(k['id'], 'e-mail'), 'turned off, nothing goes out and the issue is not cluttered')


# ======================================================================
# The workflow being edited
# ======================================================================

@scenario
def deleting_stages_the_rules_depend_on():
    ws = workspace('DelStage')
    ok(own('DELETE', f'/workspaces/{ws["id"]}/stages/in_review'))
    w = ok(own('GET', f'/workspaces/{ws["id"]}/workflow/warnings'))
    check(any('stage' in x['message'].lower() for x in w), f'deleting a stage warns about rules that pointed to it: {[x["message"] for x in w][:3]}')
    i = issue(ws, 'After', '[[WRITE:a.txt]]')
    settled(i['id'], None, 15)
    time.sleep(1)
    check(status(i['id']) == 'in_progress', 'the run itself is fine; the issue stays visible on the board')

    w2 = workspace('DelApprove')
    done_issue = issue(w2, 'Done before', agent=False, status='done')
    check(detail(done_issue['id'])['issue']['closed'] == 'done', 'an issue in Done is closed')
    x = to_review(w2)
    st_del = own('DELETE', f'/workspaces/{w2["id"]}/stages/done')
    check(st_del[0] < 300, 'Done can be deleted')
    d = detail(done_issue['id'])['issue']
    check(d['closed'] == '' and d['doneAt'] is None and d['status'] == 'backlog', f'an issue moved out of a deleted closing stage reopens ({d["status"]}, closed={d["closed"]!r})')
    log = psql(f"select count(*) from issue_stage_log where issue_id='{done_issue['id']}' and left_at is null and stage='done'")
    check(log == '0', 'and the stage history follows it')
    st, body = own('POST', f'/issues/{x["id"]}/approve')
    stages = [s['id'] for s in ok(own('GET', f'/workspaces/{w2["id"]}/stages'))]
    check(status(x['id']) in stages, f'an approval pointing to a deleted stage never sends the issue to a stage that does not exist ({st}, {status(x["id"])})')
    check(st == 400, 'it refuses, saying why')


@scenario
def copying_the_workflow():
    a, b = workspace('CopyA'), workspace('CopyB')
    lab = ok(own('POST', f'/workspaces/{a["id"]}/labels', {'name': 'vip'}))
    st = add_stage(a, 'OnlyInA')
    add_rule(a, 'enter', 'comment', {'message': 'vip-rule'}, stage='backlog', conditions={'labels': [lab['id']]})
    add_rule(a, 'enter', 'add_label', {'labelId': lab['id']}, stage=st['id'])
    closed_there = issue(b, 'closed in B', agent=False, status='cancelled')
    gone = add_stage(b, 'OnlyInB')
    moved = issue(b, 'moved', agent=False, status=gone['id'])
    # In A nothing closes at "cancelled": the copy has to reopen what it no longer closes.
    ok(own('DELETE', f'/rules/{next(r["id"] for r in rules(a) if r["action"] == "close" and r["stage"] == "cancelled")}'))
    ok(own('POST', f'/workspaces/{a["id"]}/workflow/copy', {'to': b['id']}))
    rb = rules(b)
    lb = {l['name']: l['id'] for l in ok(own('GET', f'/workspaces/{b["id"]}/labels'))}
    check('vip' in lb, 'the label was created in the destination')
    cond = next(r for r in rb if r['config'].get('message') == 'vip-rule')
    check(cond['conditions'].get('labels') == [lb['vip']], "a rule's label condition points to the destination's label, not the origin's")
    check(next(r for r in rb if r['action'] == 'add_label')['config']['labelId'] == lb['vip'], "the rule's action too")
    d = detail(moved['id'])['issue']
    first = ok(own('GET', f'/workspaces/{b["id"]}/stages'))[0]['id']
    check(d['status'] == first, 'an issue of a stage that stopped existing goes to the first')
    check(psql(f"select stage from issue_stage_log where issue_id='{moved['id']}' and left_at is null") == first, 'and its stage history follows')
    check(detail(closed_there['id'])['issue']['closed'] == '', 'the closed mark follows the new rules')
    check(own('POST', f'/workspaces/{a["id"]}/workflow/copy', {'to': '00000000-0000-0000-0000-000000000000'})[0] == 404, 'an unknown destination answers 404')


# ======================================================================
# Permissions and junk
# ======================================================================

@scenario
def isolation_between_workspaces():
    mine = workspace('Mine')
    other = workspace('Other', members=())
    mem = login('mem@x.com')
    i = issue(other, 'Secret', agent=False, status='backlog')
    repo = other['repos']['api']
    lab = ok(own('POST', f'/workspaces/{other["id"]}/labels', {'name': 'l'}))
    rule = add_rule(other, 'created', 'comment', {'message': 'x'})
    ok(own('PUT', f'/roles/{U["member_role"]}', {'name': 'Member', 'permissions': U['member_perms'] + ['repo.delete', 'repo.update', 'label.update', 'label.delete', 'workflow.manage']}))
    try:
        for label, res in [
            ('reading an issue', mem('GET', f'/issues/{i["id"]}')),
            ('reading by reference', mem('GET', f'/issues/{other["key"]}-{i["number"]}')),
            ('editing', mem('PATCH', f'/issues/{i["id"]}', {'title': 'x'})),
            ('commenting', mem('POST', f'/issues/{i["id"]}/comments', {'body': 'x'})),
            ('the diff', mem('GET', f'/issues/{i["id"]}/diff')),
            ('running', mem('POST', f'/issues/{i["id"]}/run', {})),
            ('merging', mem('POST', f'/issues/{i["id"]}/merge', {})),
            ('discarding', mem('POST', f'/issues/{i["id"]}/discard', {})),
            ('the board', mem('GET', f'/workspaces/{other["id"]}/board')),
            ('the rules', mem('GET', f'/workspaces/{other["id"]}/rules')),
            ('the SSE stream', mem('GET', f'/workspaces/{other["id"]}/events')),
            ('changing a repository', mem('PUT', f'/repos/{repo["id"]}', {'url': 'file:///remote/x.git', 'name': 'x'})),
            ('removing a repository', mem('DELETE', f'/repos/{repo["id"]}')),
            ('the branches', mem('GET', f'/repos/{repo["id"]}/branches')),
            ('renaming a label', mem('PUT', f'/labels/{lab["id"]}', {'name': 'x'})),
            ('removing a label', mem('DELETE', f'/labels/{lab["id"]}')),
            ('changing a rule', mem('PUT', f'/rules/{rule["id"]}', {'trigger': 'created', 'action': 'comment', 'config': {'message': 'y'}})),
            ('removing a rule', mem('DELETE', f'/rules/{rule["id"]}')),
        ]:
            check(res[0] == 404, f"someone else's workspace, {label}: 404 ({res[0]})")
        check(len(ok(own('GET', f'/workspaces/{other["id"]}/repos'))) == 1, 'the repository is still there')
        # Linking a label or repository of another workspace to my issue.
        m = issue(mine, 'Mine', agent=False, status='backlog', who=mem)
        check(mem('PATCH', f'/issues/{m["id"]}', {'labelIds': [lab['id']]})[0] == 400, 'a label of another workspace is refused')
        check(mem('POST', f'/workspaces/{mine["id"]}/issues', {'title': 'x', 'labelIds': [lab['id']]})[0] == 400, 'also on creation')
        check(mem('PUT', f'/issues/{m["id"]}/repos', {'all': False, 'repos': [{'repoId': repo['id']}]})[0] in (400, 404) , 'a repository of another workspace is refused')
    finally:
        ok(own('PUT', f'/roles/{U["member_role"]}', {'name': 'Member', 'permissions': U['member_perms']}))


@scenario
def permissions_cannot_be_escalated():
    ws = workspace('Esc')
    limited = ok(own('POST', '/roles', {'name': f'Runner{seq["n"]}', 'permissions': ['issue.run', 'issue.create', 'issue.comment']}))
    r = make_user(f'runner{seq["n"]}', limited['id'], [ws['id']])
    R = login(r['email'])
    i = issue(ws, 'I', '[[NO_CHANGES]]', status='backlog')
    st, _ = R('POST', f'/issues/{i["id"]}/run', {'agentId': CX['id']})
    check(st == 403 and detail(i['id'])['issue']['agentId'] == AG['id'], f'running does not switch the agent without the "choose agent" permission ({st})')
    add_rule(ws, 'access', 'lock_fields', {'fields': ['agent']}, stage='backlog')
    st, _ = own('POST', f'/issues/{i["id"]}/run', {'agentId': CX['id']})
    check(st == 200, 'the owner goes through the lock')
    settled(i['id'])
    check(R('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x', 'skillIds': ['00000000-0000-0000-0000-000000000000']})[0] == 403, 'skills on creation need the agent permission')

    # Whoever edits users cannot make themselves more than they are.
    hr = ok(own('POST', '/roles', {'name': f'HR{seq["n"]}', 'permissions': ['user.update', 'user.create', 'user.view']}))
    h = make_user(f'hr{seq["n"]}', hr['id'], [])
    H = login(h['email'])
    admin = U['admin_role']
    check(H('PATCH', f'/users/{h["id"]}', {'roleId': admin})[0] == 403, 'whoever edits users does not give themselves a bigger role')
    check(H('POST', '/users', {'name': 'p', 'email': f'p{seq["n"]}@x.com', 'password': 'password1234', 'roleId': admin})[0] == 403, 'nor creates someone with a bigger role')
    check(H('PATCH', f'/users/{U["adm"]["id"]}', {'password': 'hacked12345'})[0] == 403, "nor takes over the account of someone above them by changing the password")
    check(H('PATCH', f'/users/{r["id"]}', {'name': 'renamed'})[0] == 200, 'but edits who is not above them')
    check(H('PATCH', f'/users/{r["id"]}', {'roleId': hr['id']})[0] == 200, 'and gives roles within their own')
    hidden = workspace('Hidden', members=())
    check(H('PATCH', f'/users/{h["id"]}', {'workspaceIds': [hidden['id']]})[0] == 404, 'whoever edits users does not give themselves a workspace they cannot see')
    check(H('POST', '/users', {'name': 'q', 'email': f'q{seq["n"]}@x.com', 'password': 'password1234', 'roleId': hr['id'], 'workspaceIds': [hidden['id']]})[0] == 404, 'nor gives it to a new user')


@scenario
def repository_urls_are_not_a_way_in():
    ws = workspace('Url', repos=())
    canary = f'/tmp/pwned-{seq["n"]}'
    for url in [f'ext::sh -c touch% {canary}', f'--upload-pack=touch {canary}', '-oProxyCommand=x']:
        st, _ = own('POST', f'/workspaces/{ws["id"]}/repos', {'url': url, 'name': f'n{seq["n"]}'})
        check(st == 400, f'a URL that runs a command is refused: {url[:30]} ({st})')
    check(sh(f'ls {canary} 2>/dev/null') == '', 'and nothing ran')
    # A token in the URL never reaches people.
    real = workspace('Token')
    rid = real['repos']['api']['id']
    local = real['remotes']['api']
    psql(f"update repos set url = 'https://ghp_SECRET@example.invalid/x.git' where id = '{rid}'")
    mem = login('mem@x.com')
    got = ok(mem('GET', f'/workspaces/{real["id"]}/repos'))
    check('SECRET' not in json.dumps(got), 'the token in a URL does not reach whoever lists repositories')
    i = issue(real, 'T', 'x')
    d = settled(i['id'], ['blocked'], 40)
    all_text = json.dumps(d) + json.dumps(ok(own('GET', f'/runs/{d["runs"][-1]["id"]}/events')))
    check('ghp_SECRET' not in all_text, 'nor the comments and the log when the remote fails')
    edit = ok(own('GET', f'/workspaces/{real["id"]}/repos'))[0]
    check(psql(f"select url from repos where id = '{rid}'") == 'https://ghp_SECRET@example.invalid/x.git', 'the stored URL stays intact')
    st, _ = own('PUT', f'/repos/{rid}', {'url': edit['url'], 'name': 'api', 'description': 'edited'})
    # Saving the form with the masked URL keeps the token; the remote is unreachable here, so it may refuse, but never stores the mask.
    check('***' not in psql(f"select url from repos where id = '{rid}'"), 'saving the form back never stores the mask')


@scenario
def secrets_in_rules_stay_with_who_sees_the_workflow():
    ws = workspace('Secrets')
    add_rule(ws, 'created', 'webhook', {'url': 'http://sink:8790/ok/SECRET_TOKEN'})
    add_rule(ws, 'enter', 'script', {'script': 'curl -H "auth: SECRET_TOKEN" x'}, stage='blocked')
    low = ok(own('POST', '/roles', {'name': f'Low{seq["n"]}', 'permissions': ['issue.create']}))
    u = make_user(f'low{seq["n"]}', low['id'], [ws['id']])
    L = login(u['email'])
    st, r = L('GET', f'/workspaces/{ws["id"]}/rules')
    check(st == 200 and 'SECRET_TOKEN' not in json.dumps(r), 'without "view workflow", rules come without webhook URLs and scripts')
    check(any(x['action'] == 'run_agent' for x in r), 'but the new-issue form still knows which stage runs the agent')
    check('SECRET_TOKEN' in json.dumps(ok(login('mem@x.com')('GET', f'/workspaces/{ws["id"]}/rules'))), 'with "view workflow" they stay visible')


@scenario
def junk_gets_a_clear_answer():
    ws = workspace('Junk')
    i = issue(ws, 'J', agent=False, status='backlog')
    p = lambda body: own('PATCH', f'/issues/{i["id"]}', body)
    zero = '00000000-0000-0000-0000-000000000000'
    for label, res in [
        ('status null', p({'status': None})),
        ('status number', p({'status': 7})),
        ('title number', p({'title': 12})),
        ('title null', p({'title': None})),
        ('description number', p({'description': 3})),
        ('priority 99', p({'priority': 99})),
        ('priority text', p({'priority': 'high'})),
        ('position text', p({'position': 'x'})),
        ('agent not a uuid', p({'agentId': 'x'})),
        ('agent missing', p({'agentId': zero})),
        ('assignee number', p({'assigneeId': 5})),
        ('assignee missing', p({'assigneeId': zero})),
        ('labels not a list', p({'labelIds': 'x'})),
        ('labels missing', p({'labelIds': [zero]})),
        ('skills not a uuid', p({'skillIds': ['x']})),
        ('new issue, agent missing', own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x', 'agentId': zero})),
        ('new issue, priority 99', own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x', 'priority': 99})),
        ('new issue, assignee missing', own('POST', f'/workspaces/{ws["id"]}/issues', {'title': 'x', 'assigneeId': zero})),
        ('run with agent not a uuid', own('POST', f'/issues/{i["id"]}/run', {'agentId': 'x'})),
        ('run with agent missing', own('POST', f'/issues/{i["id"]}/run', {'agentId': zero})),
        ('comment with agent missing', own('POST', f'/issues/{i["id"]}/comments', {'body': 'x', 'sendToAgent': True, 'agentId': zero})),
    ]:
        check(res[0] == 400 or (label.startswith('comment') and res[0] == 200 and 'warning' in res[1]), f'{label}: 400, not a crash ({res[0]})')
    check(detail(i['id'])['issue']['title'] == 'J', 'and the issue is untouched')
    arch = ok(own('POST', '/agents', {'name': 'Old', 'runtime': 'claude'}))
    ok(own('DELETE', f'/agents/{arch["id"]}'))
    check(p({'agentId': arch['id']})[0] == 400, 'an archived agent cannot be chosen for an issue')
    for path in ['/issues/not-a-uuid', '/issues/abc', '/runs/x/events', '/repos/x/branches', '/users/x/profile']:
        check(own('GET', path)[0] == 404, f'GET {path}: 404 ({own("GET", path)[0]})')
    check(own('GET', f'/workspaces/x/board')[0] == 404, 'a bad workspace id: 404')
    check(own('GET', f'/workspaces/{ws["id"]}/analytics?person=bad')[0] in (400, 404), 'a bad person in analytics: 4xx')
    check(own('DELETE', '/rules/x')[0] == 404 and own('DELETE', '/agents/x')[0] == 404 and own('DELETE', '/skills/x')[0] == 404, 'deleting with a bad id: 404')
    check(own('PATCH', f'/issues/{i["id"]}', {'title': 'A' * 300, 'description': 'ção 🚀'})[0] == 200, 'long titles and emoji are fine')
    big = own('POST', f'/issues/{i["id"]}/comments', {'body': 'x' * (9 << 20)})
    check(big[0] == 400, f'a comment over the body limit: 400 ({big[0]})')
    for title in ['🚀🚀🚀', '../../etc/passwd', '-rf --force', '$(touch /tmp/x) `id`; rm -rf /', 'a' * 200]:
        n = issue(ws, title, '[[WRITE:t.txt]]')
        d = settled(n['id'], ['in_review', 'blocked'], 20)
        check(d['issue']['status'] == 'in_review', f'a hostile title runs normally: {title[:24]!r} ({d["runs"][-1]["error"][:60]})')
    check(sh('ls /tmp/x 2>/dev/null') == '', 'and nothing in a title gets executed')


@scenario
def sessions_and_accounts():
    ws = workspace('Acc')
    u = make_user(f'acc{seq["n"]}', U['member_role'], [ws['id']])
    s1, s2 = login(u['email']), login(u['email'].upper())
    check(s2('GET', '/me')[0] == 200, 'e-mail is case-insensitive on sign-in')
    check(own('POST', '/users', {'name': 'x', 'email': u['email'].upper(), 'password': 'password1234'})[0] == 409, 'a repeated e-mail is refused')
    ok(s1('PATCH', '/me', {'name': u['name'], 'password': 'password5678'}))
    check(s2('GET', '/me')[0] == 401, 'changing your own password drops your other sessions')
    check(s1('GET', '/me')[0] == 200, 'but not the current one')
    check(session()('POST', '/login', {'email': u['email'], 'password': 'password1234'})[0] == 401, 'the old password stopped working')
    i = issue(ws, 'kept', agent=False, who=s1, status='backlog')
    ok(own('PATCH', f'/issues/{i["id"]}', {'assigneeId': u['id']}))
    ok(s1('POST', f'/issues/{i["id"]}/comments', {'body': 'mine'}))
    ok(own('DELETE', f'/users/{u["id"]}'))
    check(s1('GET', '/me')[0] == 401, 'a removed user loses access at once')
    d = detail(i['id'])
    check(d['issue']['title'] == 'kept' and d['issue']['assigneeId'] is None and d['issue']['createdBy'] is None, 'their issues stay, without the person')
    check(len(d['comments']) >= 1, 'and their comments stay')
    check(session()('GET', '/me')[0] == 401, 'without a session: 401')
    ok(own('PUT', f'/workspaces/{ws["id"]}/members/{U["rev"]["id"]}'))
    rv = login('rev@x.com')
    check(rv('GET', f'/workspaces/{ws["id"]}/board')[0] == 200, 'a linked person sees it')
    ok(own('DELETE', f'/workspaces/{ws["id"]}/members/{U["rev"]["id"]}'))
    check(rv('GET', f'/workspaces/{ws["id"]}/board')[0] == 404, 'unlinking takes effect at once')
    pt = session('pt-BR')
    r = pt('POST', '/login', {'email': 'x@x.com', 'password': 'y'})
    check(r[0] == 401 and 'senha' in r[1]['error'], 'errors follow the screen language: ' + r[1]['error'])


@scenario
def web_app_is_served():
    html = urllib.request.urlopen(BASE + '/', timeout=10).read().decode()
    check('<div id="root"' in html, 'the home serves the front end')
    deep = urllib.request.urlopen(BASE + '/w/ABC/board', timeout=10).read().decode()
    check('<div id="root"' in deep, 'a deep link falls back to the app (F5 works)')
    try:
        urllib.request.urlopen(B + '/nope', timeout=10)
        code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    check(code == 404, 'an unknown API route is 404')
    check(ok(own('GET', '/runtimes'))[0]['version'] != '', 'the runtimes screen sees the installed CLIs')


# ======================================================================
# The server going down (last: it restarts the stack)
# ======================================================================

@scenario
def server_restart_in_the_middle_of_a_run():
    ws = workspace('Restart')
    i = issue(ws, 'Running', '[[SLEEP:3106]][[WRITE:partial.txt]]')
    fill = [issue(ws, f'Fill {n}', '[[SLEEP:3107]][[NO_CHANGES]]')['id'] for n in range(2)]
    wait_until(lambda: 'sleep 3106' in dc('top', 'foreman').stdout, 15)
    wait_until(lambda: sum(r['status'] == 'running' for x in fill for r in detail(x)['runs']) == 2, 15)
    q = issue(ws, 'Queued survives', '[[WRITE:q.txt]]')
    wait_until(lambda: detail(q['id'])['runs'], 5)
    # A step sequence is interrupted too: it can't be left silently in the stage.
    step = add_stage(ws, 'Step')
    add_rule(ws, 'enter', 'run_agent', {'request': '[[SLEEP:3108]]', 'wait': True}, stage=step['id'])
    dc('restart', '-t', '15', 'foreman')
    check(wait_until(healthy, 30), 'the server comes back')
    d = settled(i['id'], ['blocked'], 15)
    check(d['runs'][-1]['status'] == 'failed' and 'restart' in d['runs'][-1]['error'].lower(), 'the interrupted run fails with the reason and goes to Blocked')
    d = settled(q['id'], ['in_review'], 30)
    check(d['runs'][-1]['status'] == 'succeeded', 'the queued run survives the restart and runs')
    ok(own('POST', f'/issues/{i["id"]}/comments', {'body': 'continue [[WRITE:next.txt]]', 'sendToAgent': True}))
    d = settled(i['id'], ['in_review'], 20)
    check(d['issue']['repos'][0]['changed'], 'whatever was interrupted can be asked again')


@scenario
def interrupted_stage_step_does_not_stay_silent():
    ws = workspace('StepRestart')
    tag = 'after-' + ws['key']
    step = add_stage(ws, 'Step')
    add_rule(ws, 'enter', 'run_agent', {'request': '[[SLEEP:3109]]', 'wait': True}, stage=step['id'])
    add_rule(ws, 'enter', 'comment', {'message': tag}, stage=step['id'])
    i = issue(ws, 'Mid step', status='backlog')
    ok(own('PATCH', f'/issues/{i["id"]}', {'status': step['id']}))
    wait_until(lambda: 'sleep 3109' in dc('top', 'foreman').stdout, 15)
    dc('restart', '-t', '15', 'foreman')
    check(wait_until(healthy, 30), 'the server comes back')
    d = settled(i['id'], None, 15)
    time.sleep(2)
    check(status(i['id']) == 'blocked', f'a step interrupted by a restart goes to Blocked instead of sitting in the stage ({status(i["id"])})')
    check(has_comment(i['id'], 'restart') or has_comment(i['id'], 'Interrupted'), 'and says why')


# ======================================================================

def setup():
    # Several people racing for the first sign-up: exactly one owner.
    with cf.ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda n: session()('POST', '/setup', {'name': f'n{n}', 'email': f'r{n}@x.com', 'password': 'password1234'}), range(6)))
    winners = [r for r in res if r[0] == 200]
    print(('OK   ' if len(winners) == 1 else 'FAIL ') + f'first sign-up race: {len(winners)} owner(s)')
    global passed
    if len(winners) == 1:
        passed += 1
    else:
        fails.append(f'[setup] the first sign-up race created {len(winners)} owners')
    ok(own('POST', '/login', {'email': winners[0][1]['email'], 'password': 'password1234'}))
    ok(own('PATCH', '/me', {'name': 'Owner'}))
    psql(f"update users set email = 'owner@x.com' where id = '{winners[0][1]['id']}'")
    psql(f"delete from users where id <> '{winners[0][1]['id']}'")
    roles = {r['name']: r for r in ok(own('GET', '/roles'))}
    U['admin_role'], U['member_role'] = roles['Administrator']['id'], roles['Member']['id']
    U['member_perms'] = roles['Member']['permissions']
    ok(own('PUT', f'/roles/{U["member_role"]}', {'name': 'Member', 'permissions': U['member_perms']}))
    U['mem'] = make_user('mem', U['member_role'])
    U['rev'] = make_user('rev', U['member_role'])
    U['adm'] = make_user('adm', U['admin_role'])
    AG.update(ok(own('POST', '/agents', {'name': 'Fake', 'runtime': 'claude'})))
    CX.update(ok(own('POST', '/agents', {'name': 'FakeCodex', 'runtime': 'codex', 'model': 'o4-test', 'effort': 'high', 'instructions': 'Follow the house style'})))


JAMMERS = ('deleting_a_workspace_with_a_run', 'hung_agent_output_and_timeout')
RESTARTS = ('server_restart_in_the_middle_of_a_run', 'interrupted_stage_step_does_not_stay_silent')


def main():
    global current
    SCENARIOS.sort(key=lambda f: 2 if f.__name__ in RESTARTS else 1 if f.__name__ in JAMMERS else 0)
    only = sys.argv[1] if len(sys.argv) > 1 else ''
    setup()
    t0 = time.time()
    for f in SCENARIOS:
        if only and only not in f.__name__:
            continue
        current = f.__name__
        print(f'\n--- {current}')
        t = time.time()
        try:
            f()
        except Exception as e:
            fails.append(f'[{current}] crashed: {e}')
            print('FAIL crashed:', e)
            traceback.print_exc(limit=2, file=sys.stdout)
        print(f'    ({time.time() - t:.1f}s)')
    check(healthy(), 'the server is alive at the end of everything')
    print(f'\n{passed} ok in {time.time() - t0:.0f}s')
    if fails:
        print('\nFailures:')
        for x in fails:
            print('  - ' + x)
    print('FAILURES:', len(fails))


main()
