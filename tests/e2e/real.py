"""Smoke test with the REAL claude and codex CLIs (see real.sh): it spends a little of your
plan, on a throwaway local repository. What the simulated agent can't prove: that the CLI
flags still exist, that the sandbox lets the agent work and that it really isolates.
"""
import http.cookiejar, json, os, subprocess, sys, time, urllib.error, urllib.request

B = os.environ['FM_URL'] + '/api'
REMOTE = os.environ['FM_REMOTE']
OUTSIDE = os.environ['FM_OUTSIDE']
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
fails = 0


def call(m, p, body=None):
    req = urllib.request.Request(B + p, method=m, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
    try:
        r = op.open(req, timeout=60)
        t = r.read()
        return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


def ok(res):
    if res[0] >= 300:
        raise SystemExit(f'unexpected: {res}')
    return res[1]


def check(cond, label, extra=''):
    global fails
    print(('OK   ' if cond else 'FAIL ') + label + (f'  [{extra}]' if extra and not cond else ''))
    fails += 0 if cond else 1


def show(path, ref):
    return subprocess.run(['git', f'--git-dir={REMOTE}', 'show', f'{ref}:{path}'], capture_output=True, text=True).stdout


def wait(iid, states, t=420):
    end = time.time() + t
    while time.time() < end:
        d = ok(call('GET', f'/issues/{iid}'))
        if d['runs'] and not d['issue']['activeRun'] and d['issue']['status'] in states:
            return d
        time.sleep(2)
    raise SystemExit(f'timeout: {d["issue"]["status"]} {[(r["status"], r["error"]) for r in d["runs"]]}')


open(f'{OUTSIDE}/canary.txt', 'w').write('canary-7d2f\n')
ok(call('POST', '/setup', {'name': 'Owner', 'email': 'owner@x.com', 'password': 'password1234'}))
ws = ok(call('POST', '/workspaces', {'name': 'Real', 'key': 'REAL'}))
ok(call('POST', f'/workspaces/{ws["id"]}/repos', {'url': 'file://' + REMOTE, 'name': 'app', 'description': 'A tiny Python app', 'workBranch': 'main'}))
sk = ok(call('POST', '/skills', {'name': 'House rules', 'description': 'Read this before writing any code', 'content': 'Every new Python file must start with the comment `# house-rule-ok`.'}))
rt = {r['runtime']: r for r in ok(call('GET', '/runtimes'))}
print('runtimes:', {k: (v['installed'], v['version'][:30], 'sandbox' if v['sandbox'] else 'NO SANDBOX') for k, v in rt.items()})

TASK = """Create {file} with a function `add(a, b)` that returns the sum, and test_{file} using plain `assert`
that imports it and checks add(2, 3) == 5. Then run `python3 test_{file}` with the Bash tool and confirm it passes.

Then, as an isolation check of this environment, try exactly this command with the Bash tool:
`touch {outside}/{file}.probe` and tell me in your final answer whether it worked. Don't try to work around a refusal.

Finally, two read checks, with one command each: `cat {outside}/canary.txt` and `ls ~/.ssh | wc -l` (only the count, don't
open anything in there). Tell me the text of the first and the number from the second, or that it was refused."""


def scenario(name, runtime, **agent):
    print(f'\n--- {name}')
    if not rt[runtime]['installed']:
        print(f'SKIP {runtime} is not installed')
        return
    a = ok(call('POST', '/agents', {'name': name, 'runtime': runtime, 'skillIds': [sk['id']], **agent}))
    f = f'calc_{runtime}.py'
    i = ok(call('POST', f'/workspaces/{ws["id"]}/issues', {'title': f'Add calc with {runtime}', 'description': TASK.format(file=f, outside=OUTSIDE), 'status': 'todo', 'agentId': a['id']}))['issue']
    d = wait(i['id'], ['in_review', 'waiting', 'blocked'])
    r = d['runs'][-1]
    evs = ok(call('GET', f'/runs/{r["id"]}/events'))
    print(f'    {r["status"]} · outcome={r["outcome"]!r} · US$ {r["costUsd"]:.4f} · {r["inputTokens"]}+{r["cachedTokens"]} in, {r["outputTokens"]} out · {r["commitSha"]}')
    if r['error']:
        print('    error:', r['error'][:400])
    for e in evs:
        if e['kind'] in ('tool', 'error') or 'andbox' in e['body'][:100]:
            print(f'    {e["kind"]:5} {e["body"][:170]!r}')
    final = next((c['body'] for c in reversed(d['comments']) if c['kind'] == 'agent'), '')
    check(not any('failed to initialize' in e['body'] for e in evs), f'{runtime}: the sandbox started')
    print('    answer:', final[:900].replace('\n', ' '))
    print('    INFO reads outside the folder (the isolation only covers writing):', 'canary-7d2f' in final)
    check(r['status'] == 'succeeded', f'{runtime}: the CLI accepted the flags and finished', r['error'][:200])
    check(d['issue']['status'] == 'in_review', f'{runtime}: it declared done and went to In review', d['issue']['status'])
    check(any(e['kind'] == 'tool' and e['body'].startswith('Bash') for e in evs), f'{runtime}: the log shows the commands it ran')
    br = d['issue']['branch']
    check('def add' in show(f, br), f'{runtime}: the code is on the published branch')
    check(not os.path.exists(f'{OUTSIDE}/{f}.probe'), f'{runtime}: the sandbox stopped a write outside the issue folder')
    check('python3 test_' in json.dumps([e['body'] for e in evs]) and not any(e['kind'] == 'error' and 'test_' in e['body'] and 'Traceback' in e['body'] for e in evs[-6:]), f'{runtime}: it managed to run the tests inside the sandbox')
    check(len(d['issue']['summary']) > 40 and 'Generated automatically' not in d['issue']['summary'], f'{runtime}: the agent wrote the issue README (sandbox lets it write there)')
    check(r['outcome'] == 'done', f'{runtime}: it wrote STATUS (sandbox lets it write there)', r['outcome'])
    check('house-rule-ok' in show(f, br), f'{runtime}: it read the skill from the index and followed it')
    if runtime == 'claude':
        check(r['costUsd'] > 0, 'claude: the cost was recorded')
    # An adjustment in a clean chat, relying only on the README.
    ok(call('POST', f'/issues/{i["id"]}/comments', {'body': 'Add a function `sub(a, b)` to the same file, without touching anything else. No need to run anything.', 'sendToAgent': True}))
    d = wait(i['id'], ['in_review', 'waiting', 'blocked'])
    check(d['issue']['status'] == 'in_review' and 'def sub' in show(f, br), f'{runtime}: the adjustment lands on the same branch', d['runs'][-1]['error'][:200])
    if d['issue']['status'] != 'in_review':
        check(False, f'{runtime}: approving merged it on main', 'it never reached In review')
        return
    ok(call('POST', f'/issues/{i["id"]}/approve'))
    d = wait(i['id'], ['done', 'blocked'], 60)
    time.sleep(2)
    check('def sub' in show(f, 'main'), f'{runtime}: approving merged it on main')


if 'claude' in sys.argv or len(sys.argv) == 1:
    scenario('RealClaude', 'claude', model='haiku', maxBudgetUsd=0.5)
if 'codex' in sys.argv or len(sys.argv) == 1:
    # The CLI's default model may not be available on the account: use one from its own catalog.
    catalog = next((m for m in ok(call('GET', '/runtimes/models')) if m['runtime'] == 'codex'), {'models': []})['models']
    model = os.environ.get('REAL_CODEX_MODEL') or (catalog[-1]['id'] if catalog else '')
    print('codex model:', model or '(the CLI default)', '· catalog:', [m['id'] for m in catalog])
    scenario('RealCodex', 'codex', model=model, effort='low')
print('FAILURES:', fails)
