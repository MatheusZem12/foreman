#!/usr/bin/env bash
# Runs Foreman on your machine, using the claude, codex and git you already have
# installed and signed in. Only Postgres runs in Docker.
#
#   ./run-local.sh            starts (building if needed) on http://localhost:8700
#   ./run-local.sh --build    forces a rebuild of the front end and the server
#   ./run-local.sh --stop     stops the local Postgres
#
# Useful variables: FOREMAN_ADDR (default 127.0.0.1:8700; 0.0.0.0:8700 opens it to the
# network), FOREMAN_DATA (default ./data), FOREMAN_MAX_PARALLEL (default 3).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
PROJECT=foreman-local
PG_PORT=${FOREMAN_PG_PORT:-5432}
compose() { docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.dev.yml "$@"; }

if [[ "${1:-}" == "--stop" ]]; then
  compose stop db
  exit 0
fi

need() { command -v "$1" >/dev/null || { echo "✗ missing command '$1'"; exit 1; }; }
need docker
need git
for bin in claude codex; do
  command -v "$bin" >/dev/null && echo "✓ $bin: $($bin --version 2>/dev/null | head -1)" || echo "! $bin not found in PATH ($bin agents won't run)"
done

# 1. Postgres (127.0.0.1 only)
echo "→ Postgres on 127.0.0.1:$PG_PORT"
compose up -d --wait db >/dev/null

# 2. Front
if [[ "${1:-}" == "--build" || ! -f server/internal/webui/dist/index.html ]]; then
  need npm
  echo "→ Building the front end"
  (cd web && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build >/dev/null)
fi

# 3. Server (local Go if there is one; otherwise it builds in a container and runs natively)
if [[ "${1:-}" == "--build" || ! -x bin/foreman || -n "$(find server -name '*.go' -newer bin/foreman -print -quit)" || -n "$(find server/internal/webui/dist -newer bin/foreman -print -quit)" ]]; then
  echo "→ Building the server"
  mkdir -p bin "$HOME/.cache/foreman-go"
  if command -v go >/dev/null; then
    (cd server && CGO_ENABLED=0 go build -o "$ROOT/bin/foreman" ./cmd/foreman)
  else
    docker run --rm -u "$(id -u):$(id -g)" -v "$ROOT/server:/src" -v "$ROOT/bin:/out" -w /src \
      -v "$HOME/.cache/foreman-go:/tmp/gocache" -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gocache/gopath -e GOFLAGS=-buildvcs=false -e CGO_ENABLED=0 \
      golang:1.23 go build -o /out/foreman ./cmd/foreman
  fi
fi

# 4. Run
export DATABASE_URL="postgres://foreman:${POSTGRES_PASSWORD:-foreman}@127.0.0.1:$PG_PORT/foreman?sslmode=disable"
export FOREMAN_DATA="${FOREMAN_DATA:-$ROOT/data}"
export FOREMAN_ADDR="${FOREMAN_ADDR:-127.0.0.1:8700}"
echo "→ Foreman on http://${FOREMAN_ADDR/0.0.0.0/localhost}  (Ctrl+C to stop)"
exec ./bin/foreman
