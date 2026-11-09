#!/usr/bin/env bash
# End-to-end tests: each suite gets a clean Foreman in an isolated Docker (port 18700),
# with test git repositories, a simulated agent (fake/claude, fake/codex), a real SMTP
# server (Mailpit, port 18725) and a webhook receiver (port 18790).
#
#   e2e.py        what each feature does
#   flow.py       the complete flow and the rules under attack: races, restarts, bypasses, junk
#   tests/ui      the flow in a real browser (needs chromium; `ui` is run only when asked)
#   real.sh       the real claude and codex CLIs, on their own: it spends a little of your plan
#
# Usage: tests/e2e/run.sh [--no-build] [e2e|flow|ui] [flow scenario filter]
#   E2E_KEEP=1 keeps the last stack up at the end. UI_SHOTS=<folder> saves screenshots.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/foreman-e2e.XXXXXX")"
PROJECT="fme2e$$"

BUILD=1
if [[ "${1:-}" == "--no-build" ]]; then BUILD=; shift; fi
SUITES=(e2e flow)
if [[ "${1:-}" == "e2e" || "${1:-}" == "flow" || "${1:-}" == "ui" ]]; then SUITES=("$1"); shift; fi

if [[ -n "$BUILD" ]]; then
  echo "→ foreman:dev image"
  docker build -q -t foreman:dev "$ROOT" >/dev/null
fi

cat > "$WORK/compose.yml" <<YML
name: $PROJECT
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: foreman, POSTGRES_PASSWORD: foreman, POSTGRES_DB: foreman }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U foreman"], interval: 2s, retries: 30 }
  mail:
    image: axllent/mailpit:v1.20
    ports: ["127.0.0.1:18725:8025"]
  sink:
    image: foreman:dev
    entrypoint: ["node", "/sink.js"]
    healthcheck: { disable: true }
    volumes: ["$HERE/sink.js:/sink.js:ro"]
    ports: ["127.0.0.1:18790:8790"]
  foreman:
    image: foreman:dev
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://foreman:foreman@db:5432/foreman?sslmode=disable
      CLAUDE_BIN: /fake/claude
      CODEX_BIN: /fake/codex
      FOREMAN_RUN_TIMEOUT: 45s
    volumes: ["$HERE/fake:/fake:ro", "$WORK/remote:/remote"]
    ports: ["127.0.0.1:18700:8700"]
YML

down() { docker compose -f "$WORK/compose.yml" down -v >/dev/null 2>&1 || true; }
trap '[[ -n "${E2E_KEEP:-}" ]] || down' EXIT

fail=0
for suite in "${SUITES[@]}"; do
  down
  rm -rf "$WORK/remote" "$WORK/seed"
  mkdir -p "$WORK/remote" "$WORK/seed"
  for r in api web docs; do
    (cd "$WORK/seed" && git init -q -b main "$r" && cd "$r" && echo "$r v1" > main.txt && echo "base" > conf.txt \
      && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git branch hmg)
    git clone -q --bare "$WORK/seed/$r" "$WORK/remote/$r.git"
  done
  echo "→ $suite: stack $PROJECT"
  docker compose -f "$WORK/compose.yml" up -d --wait >/dev/null 2>&1
  if [[ "$suite" == "ui" ]]; then
    (cd "$ROOT/tests/ui" && { [[ -d node_modules ]] || npm install --no-audit --no-fund --silent; })
    env -u TMPDIR FM_REMOTES="$WORK/remote" FM_SHOTS="${UI_SHOTS:-}" node "$ROOT/tests/ui/ui.mjs" 2>&1 | tee "$WORK/$suite.out" || true
  else
    cp "$HERE/$suite.py" "$WORK/"
    COMPOSE_FILE="$WORK/compose.yml" python3 -u "$WORK/$suite.py" "$@" | tee "$WORK/$suite.out" || true
  fi
  grep -q "^FAILURES: 0$" "$WORK/$suite.out" || fail=1
  docker compose -f "$WORK/compose.yml" logs foreman 2>&1 | grep -E 'panic|goroutine ' | head -20 || true
done
exit "$fail"
