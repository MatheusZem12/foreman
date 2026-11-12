// The flow in a real browser, against the stack run.sh starts (port 18700): what the API
// tests can't see. Sign-up, the board updating live, dragging, approval, each screen
// loading without errors, the phone layout and the language.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:18700';
const REMOTE_DIR = process.env.FM_REMOTES;
const SHOTS = process.env.FM_SHOTS;
let fails = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

process.on('unhandledRejection', async (e) => {
  console.log('FAIL the script stopped:', String(e).split('\n').slice(0, 3).join(' '));
  console.log('FAILURES:', fails + 1);
  process.exit(0);
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });

// Every page is watched: an uncaught exception, a console error or a 5xx is a failure.
const problems = [];
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`exception on ${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    // A refused action (403/400) logs a network error in the console; the toast is what counts.
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`console on ${page.url()}: ${m.text()}`);
  });
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`); });
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

// API seeds, with the session of the page.
const api = (page) => async (method, path, body) => {
  const res = await page.request.fetch(`${BASE}/api${path}`, { method, data: body, headers: { 'Content-Type': 'application/json' } });
  if (res.status() >= 300) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};

function remote(name) {
  const d = mkdtempSync(join(tmpdir(), 'fmui'));
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(d, 'main.txt'), 'v1\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  git('clone', '-q', '--bare', d, `${REMOTE_DIR}/${name}.git`);
  rmSync(d, { recursive: true, force: true });
}

const signIn = async (page, email) => {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
};

// ---------- first access ----------
const owner = await newPage();
await owner.goto(`${BASE}/`);
// The landing page is its own file, fetched after the session check: wait for it.
const landed = await owner.waitForFunction(() => document.body.innerText.length > 50, null, { timeout: 10000 }).then(() => true, () => false);
check((await owner.title()) !== '' && landed, 'signed out, the home shows the landing page');
await owner.goto(`${BASE}/login`);
await owner.getByLabel('Name').fill('Owner');
await owner.getByLabel('Email').fill('owner@x.com');
await owner.getByLabel('Password').fill('password1234');
await owner.getByRole('button', { name: 'Create and sign in' }).click();
await owner.waitForURL((u) => u.pathname === '/new' || u.pathname.startsWith('/w/'), { timeout: 10000 });
check(new URL(owner.url()).pathname === '/new', 'the first access creates the owner and asks for a workspace');
await owner.getByLabel('Name').fill('Shop');
const keyField = owner.getByLabel('Key');
await keyField.fill('SHOP');
await owner.getByRole('button', { name: 'Create workspace' }).click();
await owner.waitForURL('**/w/SHOP**', { timeout: 10000 });
check(true, 'creating the workspace goes to its board');

const call = api(owner);
remote('shop');
const ws = (await call('GET', '/workspaces'))[0];
await call('POST', `/workspaces/${ws.id}/repos`, { url: 'file:///remote/shop.git', name: 'shop', description: 'the shop' });
const agent = await call('POST', '/agents', { name: 'Fake', runtime: 'claude' });
const roles = await call('GET', '/roles');
const member = roles.find((r) => r.name === 'Member');
await call('POST', '/users', { name: 'Mem', email: 'mem@x.com', password: 'password1234', roleId: member.id, workspaceIds: [ws.id] });
const low = await call('POST', '/roles', { name: 'Low', permissions: ['issue.create'] });
await call('POST', '/users', { name: 'Low', email: 'low@x.com', password: 'password1234', roleId: low.id, workspaceIds: [ws.id] });

// ---------- creating an issue on the screen; the board updates by itself ----------
await owner.goto(`${BASE}/w/SHOP`);
const column = (page, name) => page.locator('section').filter({ has: page.locator('[data-col-head]', { hasText: name }) }).first();
const inColumn = (page, name, title, timeout = 30000) => column(page, name).getByText(title).first().waitFor({ timeout }).then(() => true, () => false);
await column(owner, 'To do').getByTitle('New issue in this column').click();
await owner.getByPlaceholder('Issue title').fill('Add a discount');
await owner.getByPlaceholder(/Description/).fill('Please add it [[SLEEP:3]][[WRITE:discount.txt]]');
await owner.keyboard.press('Control+Enter');
await owner.getByText('Add a discount').first().waitFor({ timeout: 10000 });
check(true, 'the new issue shows up on the board');
check(await inColumn(owner, 'In progress', 'Add a discount'), 'it moves to In progress without reloading the page');
await shot(owner, '01-board-running');
check(await inColumn(owner, 'In review', 'Add a discount'), 'and to In review when the agent finishes, also live');
await shot(owner, '02-board-review');

// ---------- the issue page ----------
await owner.getByText('Add a discount').first().click();
await owner.waitForURL('**/issues/SHOP-1', { timeout: 10000 });
await owner.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 10000 });
check(true, 'the issue page opens with the Approve button');
await owner.getByRole('button', { name: /^README/ }).click();
check(await owner.getByText('Summary').first().isVisible(), 'the README tab shows what the agent wrote');
await owner.getByRole('button', { name: /^Changes|^Diff/ }).first().click();
check(await owner.getByText('discount.txt').first().waitFor({ timeout: 10000 }).then(() => true, () => false), 'the diff tab shows the changed file');
await shot(owner, '03-issue-diff');
await owner.getByRole('button', { name: /^Runs/ }).first().click();
check(await owner.getByText(/Fake/).first().isVisible(), 'the runs tab lists the run');
await owner.getByRole('button', { name: /^Activity/ }).first().click();

// ---------- a Member: the rules on the screen ----------
// Wide enough to see all eight columns: dragging needs both ends on the screen.
const mem = await newPage({ viewport: { width: 2600, height: 900 } });
await signIn(mem, 'mem@x.com');
await mem.waitForURL('**/w/SHOP**', { timeout: 10000 });
await mem.goto(`${BASE}/w/SHOP/issues/SHOP-1`);
await mem.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 10000 });
check(await mem.getByRole('button', { name: /^Merge/ }).count() === 0, 'without approval, the Member has no Merge button');

// Dragging from In review to Done: the server refuses, the card goes back, a message explains.
await mem.goto(`${BASE}/w/SHOP`);
await column(mem, 'In review').getByText('Add a discount').first().waitFor({ timeout: 10000 });
const from = await column(mem, 'In review').getByText('Add a discount').first().boundingBox();
const to = await mem.locator('[data-col-head]', { hasText: 'Done' }).first().boundingBox();
await mem.mouse.move(from.x + 10, from.y + 5);
await mem.mouse.down();
await mem.mouse.move(from.x + 40, from.y + 30, { steps: 5 });
await mem.mouse.move(to.x + 20, to.y + 60, { steps: 15 });
await mem.waitForTimeout(300);
await mem.mouse.up();
check(await mem.getByText(/requires 1 approval/).first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'dragging past the approval shows why it was refused');
await mem.waitForTimeout(800);
await shot(mem, '04-drag-refused');
check(await inColumn(mem, 'In review', 'Add a discount', 5000), 'and the card goes back to In review');

// A drag that is allowed really moves it.
const m = await api(mem)('POST', `/workspaces/${ws.id}/issues`, { title: 'Manual card', status: 'backlog' });
await mem.reload();
await column(mem, 'Backlog').getByText('Manual card').first().waitFor({ timeout: 10000 });
const a = await column(mem, 'Backlog').getByText('Manual card').first().boundingBox();
const b = await mem.locator('[data-col-head]', { hasText: 'Blocked' }).first().boundingBox();
await mem.mouse.move(a.x + 10, a.y + 5);
await mem.mouse.down();
await mem.mouse.move(a.x + 40, a.y + 30, { steps: 5 });
await mem.mouse.move(b.x + 20, b.y + 60, { steps: 15 });
await mem.waitForTimeout(300);
await mem.mouse.up();
check(await inColumn(mem, 'Blocked', 'Manual card', 5000), 'an allowed drag moves the card');
check((await api(mem)('GET', `/issues/${m.issue.id}`)).issue.status === 'blocked', 'and the server agrees');

// ---------- approving on the screen merges ----------
await owner.bringToFront();
await owner.getByRole('button', { name: 'Approve' }).click();
check(await owner.getByText('Merged', { exact: false }).first().waitFor({ timeout: 10000 }).then(() => true, () => false)
  || (await call('GET', '/workspaces/' + ws.id + '/issues?q=discount'))[0].status === 'done', 'approving on the screen goes to Done and merges');
await owner.waitForTimeout(1000);
const done = (await call('GET', `/workspaces/${ws.id}/issues?q=discount`))[0];
check(done.status === 'done' && done.repos[0].mergedInto === 'main', 'the issue is Done and merged');
await shot(owner, '05-issue-done');

// ---------- a comment to the agent on the screen ----------
await owner.goto(`${BASE}/w/SHOP/issues/SHOP-1`);
await owner.getByPlaceholder('Comment…').fill('please also [[WRITE:more.txt]]');
await owner.getByText('Send to the agent').click();
await owner.getByRole('button', { name: /^(Comment|Send)/ }).last().click();
const reopened = await (async () => {
  for (let i = 0; i < 40; i++) {
    const x = await call('GET', '/issues/SHOP-1');
    if (x.runs.length === 2 && !x.issue.activeRun) return x;
    await owner.waitForTimeout(250);
  }
  return null;
})();
check(reopened && reopened.issue.status === 'in_review', 'a comment sent to the agent reopens the done issue and runs it');

// ---------- every screen, for every kind of person ----------
const SCREENS = [
  ['Board', '/w/SHOP'], ['Issue', '/w/SHOP/issues/SHOP-1'], ['Analytics', '/w/SHOP/analytics'], ['Overall analytics', '/w/SHOP/analytics-overall'],
  ['Workflow', '/w/SHOP/workflow'], ['Workspace', '/w/SHOP/workspace'], ['Labels', '/w/SHOP/labels'], ['Agents', '/w/SHOP/agents'],
  ['Skills', '/w/SHOP/skills'], ['Users', '/w/SHOP/config/users'], ['Permissions', '/w/SHOP/config/permissions'],
  ['Server', '/w/SHOP/config/server'], ['Account', '/w/SHOP/config/account'], ['About', '/about'],
];
for (const [name, path] of SCREENS) {
  await owner.goto(BASE + path);
  await owner.waitForTimeout(500);
  const text = (await owner.locator('body').innerText()).trim();
  check(text.length > 20, `the owner opens ${name}`);
  await shot(owner, `screen-${name.toLowerCase().replace(/ /g, '-')}`);
}
await owner.goto(`${BASE}/w/SHOP/workflow`);
await owner.waitForTimeout(800);
check(await owner.getByText('AI finished').first().isVisible() && await owner.getByText('In review').first().isVisible(), 'the flow map draws the stages and the arrows');
for (const tab of ['Stages & rules', 'General rules']) {
  await owner.getByText(tab, { exact: true }).first().click();
  await owner.waitForTimeout(400);
  await shot(owner, `workflow-${tab.split(' ')[0].toLowerCase()}`);
  check((await owner.locator('body').innerText()).includes('In review'), `the "${tab}" tab lists the default workflow`);
}

const lowPage = await newPage();
await signIn(lowPage, 'low@x.com');
await lowPage.waitForURL('**/w/SHOP**', { timeout: 10000 });
await lowPage.waitForTimeout(500);
for (const [name, path] of [['Workflow', 'workflow'], ['Agents', 'agents'], ['Skills', 'skills'], ['Analytics', 'analytics']]) {
  await lowPage.goto(`${BASE}/w/SHOP/${path}`);
  await lowPage.waitForTimeout(300);
  check(!lowPage.url().endsWith(`/${path}`), `a role without permission is sent away from ${name}`);
}
await lowPage.goto(`${BASE}/w/SHOP`);
await lowPage.waitForTimeout(300);
const menu = await lowPage.locator('nav, aside').first().innerText().catch(() => '');
check(!/Workflow|Agents|Skills/.test(menu), 'and those screens are not in the menu');
await lowPage.getByText('New issue', { exact: true }).first().click();
await lowPage.getByPlaceholder('Issue title').fill('From the low role');
await lowPage.keyboard.press('Control+Enter');
check(await lowPage.getByText('From the low role').first().waitFor({ timeout: 8000 }).then(() => true, () => false), 'but it creates issues (the form sends only what the role allows)');

// ---------- phone ----------
const phone = await newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
await signIn(phone, 'mem@x.com');
await phone.waitForURL('**/w/SHOP**', { timeout: 10000 });
for (const [name, path] of [['Board', '/w/SHOP'], ['Issue', '/w/SHOP/issues/SHOP-1'], ['Analytics', '/w/SHOP/analytics'], ['Workflow', '/w/SHOP/workflow'], ['Account', '/w/SHOP/config/account']]) {
  await phone.goto(BASE + path);
  await phone.waitForTimeout(500);
  const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 1, `on a phone, ${name} has no sideways page scroll (${over}px)`);
  await shot(phone, `phone-${name.toLowerCase()}`);
}

// ---------- Portuguese ----------
const pt = await newPage({ locale: 'pt-BR' });
await signIn2(pt);
async function signIn2(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('E-mail').or(page.getByLabel('Email')).first().fill('mem@x.com');
  await page.locator('input[type=password]').fill('password1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL('**/w/SHOP**', { timeout: 10000 });
}
await pt.waitForTimeout(500);
const ptText = await pt.locator('body').innerText();
check(/Nova issue|Fluxo|Em revisão/.test(ptText), 'a Portuguese browser gets the interface in Portuguese');
await pt.goto(`${BASE}/w/SHOP/issues/SHOP-1`);
await pt.waitForTimeout(600);
const ptIssue = await pt.locator('body').innerText();
check(!/\b(Requested by|Created by|In review|Waiting for you)\b/.test(ptIssue), 'the issue page has no leftover English labels');

// ---------- nothing broke along the way ----------
check(problems.length === 0, `no exception, console error or 5xx on any screen${problems.length ? ':\n  ' + [...new Set(problems)].slice(0, 12).join('\n  ') : ''}`);
await browser.close();
console.log('FAILURES:', fails);
process.exit(0);
