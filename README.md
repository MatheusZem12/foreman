# Foreman

A self-hosted issue tracker whose issues are carried out by coding agents (Claude Code and Codex). You create the issue, assign an agent, and it moves on its own:

**To do → In progress → In review → merge**

Each run works in an isolated worktree on the server, on its own branch `fm/<key>-<n>-<slug>`. The result is pushed to the remote. The merge lands on the branch you choose.

The idea is little configuration and more function. There are only three things to configure: **agents**, **skills** and each workspace's **repositories**. Who may configure them is set by role. Everything else is creating, ordering and following issues, in the browser, on a tablet or on a phone.

**It runs only on your machine.** There is no Foreman cloud and no telemetry. The agents are the `claude` and `codex` you are already signed in to, git uses your credentials and the server listens only on `localhost`. Reaching it from outside is your call: VPN, tunnel or proxy (see [Access from outside](#access-from-outside)). The `/about` page explains everything with screenshots.

## Run it on your machine

```bash
./run-local.sh     # Postgres in Docker + a native server with your claude/codex/git
```

Open `http://localhost:8700`. The first time, the script builds the front end (npm) and the server (local Go or, without Go, in a container). Requirements: Docker, git, Node and `claude` and/or `codex` on the PATH.

- `./run-local.sh --build`: forces a rebuild.
- `./run-local.sh --stop`: stops Postgres.
- Data lives in `./data` (clones, worktrees, summaries) and in the `foreman-local` Postgres volume.

## How it works

| | |
|---|---|
| **Agents as presets** | You create them once (runtime, model, effort, a US$ cap, instructions and a bundle of indexed skills) and they apply to every workspace. You can have several on the same model with different jobs. On each issue or adjustment you pick (and switch) the agent. |
| **Several repositories** | A workspace has as many repositories as you like. Each issue gets a worktree of each one (or only of the chosen ones) and the AI touches only the ones the request needs, guided by each repository's **description**. Only the changed ones get a branch, a push and a merge. |
| **Clean chat + README** | Every request opens a fresh chat. Continuity comes from the **issue README**, which the agent rewrites when it finishes (goal, what was done per request, files, decisions, how to test, open items), from the **request history** Foreman records (when, agent, request, outcome, commits) and from the commit log. Both go as attachments to the next chat and stay in the issue's README tab. If the agent doesn't write the README, the server generates one. |
| **Declared outcome** | When it finishes, the AI writes to `$FOREMAN_STATUS` whether it is `done`, `waiting: <what it needs>` or `incomplete: <why>`. Done goes to *In review*; the others go to *Waiting for you*, with the question as a comment and a box to reply straight to the agent. |
| **Stages and automations** | The core of Foreman; see [Workflow, roles and automations](#workflow-roles-and-automations). |
| **Shared skills** | Markdown guides, with optional scripts, stored in the database. You index skills on agents: call the agent and its bundle comes along. Agents and issues store only the reference: edit it once and it applies everywhere. *Attach to all* includes the skill in every run. The prompt carries only the index (name, description and path); the agent reads the whole skill when it needs it. |
| **Adjustment by comment** | A comment with *Send to the agent* becomes a new run (possibly by another agent) in the same worktree, receiving the summary and the request. |
| **Safe merge** | `--no-ff` in a temporary worktree, then a push. The target is the remote's default branch, or the one you choose on the issue. With several repositories, every merge is done locally first: if one conflicts, **none** is published. The issue goes to *Blocked* and the **Resolve conflict with AI** button brings the target into the issue branch and asks the agent to resolve it. The merge is refused while any conflict marker remains. |
| **Real time** | The agent log, the board and comments update live over SSE for everyone looking. |
| **Analytics** | Cost, tokens (input, cache, output), time and runs per day and per agent. |

An issue's path:
- creating it in **To do** with an agent, or moving it there, queues it; every new request (issue, adjustment, reply, rule) moves the issue to **In progress** at once;
- the AI finished → **In review**; it needs someone or didn't finish → **Waiting for you**; it failed or conflicted → **Blocked**;
- in **In review**, the **✓ Approve** button takes it to **Done**, where by default a rule merges (swap it for "Open PR" if you prefer);
- an issue in **Backlog** doesn't run; moving it to **Backlog** or **Cancelled** stops the run.

## Workflow, roles and automations

Users and roles are **global**; access to workspaces is not. Each workspace's workflow lives under *Workflow & automations*.

**Nothing is fixed per stage.** Every workspace is born with a **default workflow** (Backlog → To do → In progress → Waiting for you → In review → Blocked → Done → Cancelled) and with **default rules** doing what used to be built into the code. Everything can be renamed, reordered, switched off or deleted, and you can build a workflow from scratch. The stage itself is just **a name, a place in the workflow and whether it runs in parallel** with the previous one; when removed, its issues go to the first stage.

The default rules (the `seed_workflow` function in the database):
- **To do, on entry:** run the issue's agent (without an agent, it stays a manual task; without a repository, the rule warns and the issue stays where it is).
- **Agent started** (requested from the board, a comment or a reply): move to In progress.
- **Run finished**, while in In progress: done → In review; needs you or incomplete → Waiting for you; failed → Blocked; stopped → Backlog.
- **Backlog and Cancelled, on entry:** stop the agent.
- **Merge done** → Done; **merge conflict** → Blocked.
- **A rule failed** (agent without a repository, script, merge, PR…) → Blocked, unless the rule itself has "If it fails, move to".
- **Done** closes the issue as resolved and **Cancelled** as cancelled (the "Close the issue" access rule); that's what analytics counts.
- **In review:** 1 approval → Done. **Done, on entry:** merge. **Waiting for you, on entry:** an e-mail to whoever asked.

The **"the issue is in stage"** filter makes a general-trigger rule (agent finished, merge…) apply only from certain stages. **Run agent** can **wait to finish in the stage** (the issue stays there and the following rules run afterwards, e.g. an AI review) or be a normal request (the "agent started/finished" rules decide the stage).

**Analytics follows the workflow you built:** each stage gets a kind from its rules (the agent works there, it waits for someone to answer the AI, it has approval, it closes), and from that come "where the time goes", each stage's kind in the time per stage, and the response time per person.

**Access rules** (*+ Rule → Always: access & locks*) apply the whole time the issue is in the stage; several add up:
- **Who works on this stage's issues** (roles and/or people): edit, comment, run the agent, take it out.
- **Who may bring issues here.**
- **Locks:** fields nobody changes there (title, description, priority, labels, agent, repositories, assignee).
- **Entry requirements:** having an agent, an assignee, a description or code changes.
- **A limit** on issues at the same time.
- **Read-only:** once in, nobody touches it any more (only the owner).
- **Approval:** the issue gets the *✓ Approve* button; it only moves on when **N different people** approve (each counts once) and goes on its own to the chosen destination. E.g. with 2, the tech lead approves (1 of 2) and the issue waits; the PO approves (2 of 2) and it moves on. *In review* is born with 1 approval → *Done*.
- **Stage owners** (e-mail recipients).

E.g. an Intern and a Junior can share **the same permission role**, but Triage only accepts the Intern and Development only the Junior: each works in their own stage. The owner goes through everything.

**Screens by permission.** Each screen has a "view" permission (Analytics, Workflow, Repositories & people, Agents, Skills, Users). The screen shows up with the "view" or with any permission to change it; with none, it leaves the menu and the address is blocked; with "view" only, it opens read-only. Under *Users*, whoever can view opens each person's **profile**: what their role allows and, in each shared workspace, which stages they work on, bring issues to, approve or own, the rules that mention them, and their open, created and resolved issues.

**Fine-grained permissions** (per role): create, edit text, move, comment, priority, labels, agent, repositories, assignee, run, approve, merge, delete, workspace labels, configure and copy the workflow. E.g. a role that only creates issues picks neither the agent nor the priority. Each issue returns what the person may do there (`caps`); the screen locks the rest and the server checks again.

**Flow map.** The *Flow map* tab draws the process top to bottom: the board path, an arrow per move rule (with its condition, e.g. "Urgent/High"), the approvals and, if you want, what the system does on its own (agent starts, AI finished, needs you, failed). **Parallel stages** ("beside the previous one") sit side by side on the map and share a column on the board, one under the other. The board's column order comes only from the workflow.

**Rule order.** A stage's rules run top to bottom, in the order you drag them. Quick actions (notify, comment, set fields) go on at once; script, merge and PR wait to finish; **run agent** in a stage rule waits too: the issue stays in the stage while the agent works and the next rule only runs when it finishes (if it needs someone, the issue goes to *Waiting for you*; if it fails, to *Blocked* or to the "If it fails" stage). **Move** takes the issue out of the stage, so leave it last — the screen warns you when it isn't. E.g. *say it arrived → agent reviews → say it finished → move to QA*.

**Rules** = trigger + conditions + action. Triggers: entering, leaving or sitting X hours in a stage; issue created; comment; run finished (done, waiting, incomplete, failed); assignee set; priority changed; cost above US$ X. Conditions: priority, labels, agent, the role of whoever caused it. Actions: notify by e-mail (whoever asked, whoever created, the assignee, the stage owners, the team, administrators only, chosen roles or users — never a typed e-mail), webhook, comment, move, set the assignee (fixed, whoever created, whoever asked, or spread to whoever has the fewest issues in a group), priority, label, agent, run agent, open a PR, merge and script. Every action becomes a comment on the issue; loops stop on their own.

**Copying the workflow** from X to Y **replaces** Y's workflow: it is torn down and made identical to X's (stages, rules and access rules). The preview shows what will be deleted in Y, how many issues go to the first stage (those in stages that stop existing) and what will need adjusting. People without access to Y come along, without gaining access because of it, and show up in Y's workflow warnings for someone to fix. Labels are found or created by name. The workflow screen also warns when someone loses access later.

**Analytics** has two levels, each with its own permissions:
- **Workspace** (*Analytics*, `analytics.view`): the numbers of the workspace you are in. To see another project, go into it. With nothing else, it shows only **your** numbers (issues you created or own, their runs and the runs you requested). With `analytics.team`, you can see **everyone** or **one person**.
- **Overall** (*Overall Analytics*, `analytics.global`): every workspace you can access, added up; only your numbers. With `analytics.global_team`, everyone or one person.
- The server checks every request: without the team permission, asking for someone else's numbers gives 403.

**Skills** link to every issue, to chosen agents or to none; an agent shows the skills of its bundle.

A workspace key (the issue prefix) doesn't change after it is created.

## Users and permissions

- **Owner:** the first sign-up. Can do everything, is the only one who sees the **Permissions** screen and can't be edited or removed by anyone else. After the owner there is no public sign-up.
- **Roles:** the owner builds roles by ticking permissions. Each user gets a role under *Users*. Available permissions:
  - issues: create, edit/move/comment, delete, run agents, merge/discard;
  - agents and skills: create, edit, delete;
  - workspaces: create, rename, delete, see all (without being linked), link people;
  - repositories: add, edit, remove;
  - users: create, edit (password, role, workspaces), remove;
  - server: configure e-mail.
- **Starting roles:** *Administrator* (everything) and *Member* (create, edit, run and merge issues). Changing a role applies at once to everyone using it.
- **Workspaces:** whoever lacks "see all" sees only the workspaces they were linked to.
- **Guarantee:** the API checks permission and membership on every route. Without permission the answer is 403; someone else's workspace answers 404. Menus and buttons disappear according to the role.

## Notification e-mail

When someone creates an issue, everyone in the workspace gets an e-mail.

- **Recipients:** the linked members and the admins. Left out: whoever created the issue and whoever turned e-mail off under *My account*.
- **One message per issue:** the recipients go in Bcc.
- **One thread per workspace:** the subject is always `[Foreman] <workspace name>` and every message points to the same root (`In-Reply-To`/`References`). Gmail, Outlook and the like group everything into one thread per workspace.
- **Settings in the database:** SMTP lives in the `settings` table, not in `.env`. The admin configures it under *Server → Notification email*:
  - server, port, security, user and password, sender and the Foreman address used in links;
  - shortcuts for Gmail and Outlook;
  - a **Send me a test** button.
- **Password:** it stays in the database and never goes back to the browser.
- **On and off:** it starts off, and while off nobody gets anything. When the admin turns it on, it notifies everyone who hasn't turned it off in their own profile.
- **Gmail:** use an [app password](https://myaccount.google.com/apppasswords).

## Language and theme

- **English and Brazilian Portuguese.** On the first visit the browser's language applies. You can switch it in the menu footer, on sign-in, on the landing page or under *My account → Appearance & language*. Server error messages follow the screen's language (the front end sends `X-Lang`).
- **Light, dark or system theme**, in the same places. It is stored in the browser and applied before the page loads, with no flicker.
- **To translate new text:** in the front end, use `t('English text')`, with `{0}`, `{1}` for values, and put the translation in `web/src/locales/pt-BR.ts`. On the server, use `bad(...)` or `forbidden(...)` and put the translation in `server/internal/api/i18n.go`. Anything without a translation shows in English.

## Stack

- **Go**: HTTP server, a run queue in Postgres (`FOR UPDATE SKIP LOCKED`, survives restarts), agent processes in their own group (cancelling kills the whole tree), git through the system binary. Everything becomes a single binary, with the front end embedded.
- **PostgreSQL**: users, access roles, settings (e-mail), workspaces, per-issue repositories, repositories, agents, skills, issues, runs, log events and comments.
- **React + TypeScript + Vite + Tailwind**: a responsive, installable SPA (PWA). TanStack Query for the cache, dnd-kit for dragging with mouse and touch.
- **Docker**: the image ships `git`, `claude` and `codex`. The agents run as a regular user.

```
server/
├── cmd/foreman/main.go
└── internal/
    ├── api/        JSON routes, session auth, SSE
    ├── runner/     queue, runs, Claude/Codex events, prompt, git, merge
    ├── store/      Postgres queries
    ├── db/         pool + embedded migrations (migrations/*.sql)
    ├── hub/        in-memory pub/sub for SSE
    ├── notify/     new-issue e-mail (SMTP)
    └── webui/      compiled front end (embed)
web/src/
├── pages/          Landing, Board, IssuePage, Analytics, Agents, Skills, WorkspaceSettings, Account, Roles
├── components/     Layout, NewIssue, SearchModal, pickers, ui
└── lib/            api, types, queries, real time, formatting
```

## Deploy on a server

```bash
cp .env.example .env          # set POSTGRES_PASSWORD
docker compose up -d --build
```

Open `http://localhost:8700` (by default the compose file publishes only on `127.0.0.1`; `FOREMAN_BIND=0.0.0.0` in `.env` opens it to the network). The first visit creates the owner account.

### Agent sign-in (once)

The CLIs use the sign-in done inside the container. It is kept in the `home` volume, so it survives rebuilds.

```bash
docker compose exec foreman claude                      # run /login and follow the link
docker compose exec foreman codex login --device-auth
```

You can also use API keys: put `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env`. Under **Server** you can see whether both are installed, each one's version and how git is authenticated.

### Repository access

The server clones each repository, so it needs git credentials:

- **SSH:** generate a key inside the container and register it as a *deploy key* with write access:
  ```bash
  docker compose exec foreman sh -c 'ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub'
  ```
- **HTTPS:** use a URL with a token, e.g. `https://<token>@github.com/org/repo.git`. The token never shows in the interface or in the logs.

When saving a repository, Foreman runs `git ls-remote`: a URL that isn't a git repository the server can reach is refused. Then it clones and lists the branches. With `./run-local.sh`, your own credentials apply (SSH key, credential helper or `gh auth`).

Write a one-line **description** for each repository. It is what the AI uses to decide which ones to touch when the workspace has several.

### Direct database access

```bash
docker compose --profile admin up -d adminer   # http://localhost:8701 (local only)
```

Server `db`, user `foreman`, the password from `.env`.

### Access from outside

By default nothing leaves your machine. To use it from a phone or bring in the team, from the most closed option to the most open:

- **VPN** (Tailscale, WireGuard): recommended; nothing is exposed to the internet.
- **Local network:** `FOREMAN_ADDR=0.0.0.0:8700 ./run-local.sh` and open it by the machine's IP.
- **Tunnel** (Cloudflare Tunnel, ngrok): a public address; use HTTPS and strong passwords.
- **Your own server:** see HTTPS below.

### HTTPS

Put a reverse proxy (Caddy, nginx, Traefik) in front of port 8700 and set `FOREMAN_SECURE_COOKIE=true`. With nginx, SSE needs `proxy_buffering off;`; the server already sends `X-Accel-Buffering: no`.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://foreman:foreman@localhost:5432/foreman` | |
| `FOREMAN_ADDR` | `127.0.0.1:8700` (`:8700` in Docker) | `0.0.0.0:8700` opens it to the network |
| `FOREMAN_DATA` | `./data` (`/data` in Docker) | clones, worktrees, skills on disk |
| `FOREMAN_MAX_PARALLEL` | `3` | simultaneous runs; the rest wait in the queue |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | |
| `FOREMAN_SECURE_COOKIE` | `false` | `true` behind HTTPS |

## Development

End-to-end tests (Docker; starts an isolated stack on port 18700 with test git repositories and a simulated agent): `tests/e2e/run.sh` (or `--no-build` to reuse the image).

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # Postgres on localhost:5432
cd server && go run ./cmd/foreman                         # API on :8700 (needs Go 1.23)
cd web && npm install && npm run dev                      # front end on :5700, proxying the API
```

`npm run build` in `web/` writes the front end straight to `server/internal/webui/dist`, which is embedded in the binary.

## Costs and security

- **Cap per run:** each agent can have a US$ cap (`--max-budget-usd`, Claude only). Model and effort are also per agent.
- **Lean context:** with several repositories, the prompt carries only the map (name, description, base). Project instructions live in the repository itself (`CLAUDE.md`, `AGENTS.md`), which the agent already reads.
- **Context sent:** "Context sent to the agent" on each run shows exactly the prompt and system prompt used.
- **Isolation:** the agent runs without asking for confirmation, but inside its own CLI's sandbox (bubblewrap on Linux): it writes **only** to the issue folder and to Foreman's package cache (`data/cache`, for `npm`, `pip`, `go`…); the rest of the disk is read-only. The network stays open to install dependencies. Claude: `--permission-mode acceptEdits` + `sandbox` in the settings; Codex: `-s workspace-write` with network. Without `bwrap` on the server (e.g. in a container without user namespaces) the agent runs unsandboxed and the run log warns about it; in that case the isolation is the container's.
- **Minimal configuration:** a repository is a URL and a name (plus an optional description). The issue starts from the remote's default branch and the merge lands there; for another one, change it on the issue or ask for it in the agent's instructions. Dependencies, `.env` and tests are up to the agent, inside the worktree.
