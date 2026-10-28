#!/usr/bin/env bash
# Testes de ponta a ponta: sobe o Multica num Docker isolado (porta 18700),
# com repositórios git de teste e um agente simulado (fake/claude), e roda e2e.py.
# Uso: tests/e2e/run.sh [--no-build]   ·   E2E_KEEP=1 mantém a stack no ar no fim.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/multica-e2e.XXXXXX")"
PROJECT="mxe2e$$"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "→ imagem multica:dev"
  docker build -q -t multica:dev "$ROOT" >/dev/null
fi

echo "→ repositórios de teste em $WORK"
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
    environment: { POSTGRES_USER: multica, POSTGRES_PASSWORD: multica, POSTGRES_DB: multica }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U multica"], interval: 2s, retries: 30 }
  multica:
    image: multica:dev
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://multica:multica@db:5432/multica?sslmode=disable
      CLAUDE_BIN: /fake/claude
    volumes: ["$HERE/fake:/fake:ro", "$WORK/remote:/remote"]
    ports: ["127.0.0.1:18700:8700"]
YML

down() { [[ -n "${E2E_KEEP:-}" ]] || docker compose -f "$WORK/compose.yml" down -v >/dev/null 2>&1 || true; }
trap down EXIT
echo "→ stack $PROJECT"
docker compose -f "$WORK/compose.yml" up -d --wait >/dev/null
python3 -u "$WORK/e2e.py" | tee "$WORK/out.txt"
grep -q "^FALHAS: 0$" "$WORK/out.txt"
