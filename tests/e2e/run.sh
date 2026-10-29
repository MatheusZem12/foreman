#!/usr/bin/env bash
# End-to-end tests: starts Foreman in an isolated Docker (port 18700), with test git
# repositories and a simulated agent (fake/claude), and runs e2e.py.
# Usage: tests/e2e/run.sh [--no-build]   ·   E2E_KEEP=1 keeps the stack up at the end.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/foreman-e2e.XXXXXX")"
PROJECT="fme2e$$"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "→ foreman:dev image"
  docker build -q -t foreman:dev "$ROOT" >/dev/null
fi

echo "→ test repositories in $WORK"
mkdir -p "$WORK/remote" "$WORK/seed"
for r in api web docs; do
  (cd "$WORK/seed" && git init -q -b main "$r" && cd "$r" && echo "$r v1" > main.txt && echo "base" > conf.txt \
    && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git branch hmg)
  git clone -q --bare "$WORK/seed/$r" "$WORK/remote/$r.git"
done
cp "$HERE/e2e.py" "$WORK/"

cat > "$WORK/compose.yml" <<YML
name: $PROJECT
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: foreman, POSTGRES_PASSWORD: foreman, POSTGRES_DB: foreman }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U foreman"], interval: 2s, retries: 30 }
  foreman:
    image: foreman:dev
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://foreman:foreman@db:5432/foreman?sslmode=disable
      CLAUDE_BIN: /fake/claude
    volumes: ["$HERE/fake:/fake:ro", "$WORK/remote:/remote"]
    ports: ["127.0.0.1:18700:8700"]
YML

down() { [[ -n "${E2E_KEEP:-}" ]] || docker compose -f "$WORK/compose.yml" down -v >/dev/null 2>&1 || true; }
trap down EXIT
echo "→ stack $PROJECT"
docker compose -f "$WORK/compose.yml" up -d --wait >/dev/null
python3 -u "$WORK/e2e.py" | tee "$WORK/out.txt"
grep -q "^FAILURES: 0$" "$WORK/out.txt"
