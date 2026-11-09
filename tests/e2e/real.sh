#!/usr/bin/env bash
# Smoke test with the REAL claude and codex CLIs, with their real sandbox, on a throwaway
# local repository. It spends a little of your plan (Claude on haiku, capped at US$ 0.50).
# Nothing touches your Foreman: its own Postgres, data folder and port (18701).
#
# Usage: tests/e2e/real.sh [claude] [codex]     (both by default)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Outside /tmp on purpose: the CLIs allow writing there, so it wouldn't prove the isolation.
mkdir -p "$HOME/.cache"
WORK="$(mktemp -d "$HOME/.cache/foreman-real.XXXXXX")"
PG=fmreal$$
LOG="$WORK/server.log"

cleanup() {
  [[ -n "${SERVER:-}" ]] && kill "$SERVER" 2>/dev/null || true
  docker rm -f "$PG" >/dev/null 2>&1 || true
  [[ -f "$LOG" ]] && grep -E 'panic|goroutine ' "$LOG" | head -20 || true
  [[ -n "${REAL_KEEP:-}" ]] || rm -rf "$WORK"
}
trap cleanup EXIT

echo "→ server"
if go version >/dev/null 2>&1; then
  (cd "$ROOT/server" && CGO_ENABLED=0 go build -o "$WORK/foreman" ./cmd/foreman)
else
  docker run --rm -u "$(id -u):$(id -g)" -v "$ROOT/server:/src" -v "$WORK:/out" -w /src \
    -v "$HOME/.cache/foreman-go:/tmp/gocache" -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gocache/gopath -e GOFLAGS=-buildvcs=false -e CGO_ENABLED=0 \
    golang:1.23 go build -o /out/foreman ./cmd/foreman
fi

echo "→ Postgres"
docker run -d --name "$PG" -e POSTGRES_USER=foreman -e POSTGRES_PASSWORD=foreman -e POSTGRES_DB=foreman -p 127.0.0.1:15433:5432 postgres:16-alpine >/dev/null
for _ in $(seq 60); do docker exec "$PG" pg_isready -U foreman -q && break; sleep 1; done
sleep 2

echo "→ a throwaway repository"
mkdir -p "$WORK/seed" "$WORK/outside"
git init -q -b main "$WORK/seed"
printf '# Tiny app\n' > "$WORK/seed/README.md"
git -C "$WORK/seed" add .
git -C "$WORK/seed" -c user.name=t -c user.email=t@t commit -qm init
git clone -q --bare "$WORK/seed" "$WORK/remote.git"

DATABASE_URL="postgres://foreman:foreman@127.0.0.1:15433/foreman?sslmode=disable" \
  FOREMAN_ADDR=127.0.0.1:18701 FOREMAN_DATA="$WORK/data" "$WORK/foreman" >"$LOG" 2>&1 &
SERVER=$!
for _ in $(seq 30); do curl -fsS http://127.0.0.1:18701/api/health >/dev/null 2>&1 && break; sleep 1; done

FM_URL=http://127.0.0.1:18701 FM_REMOTE="$WORK/remote.git" FM_OUTSIDE="$WORK/outside" python3 -u "$HERE/real.py" "$@" | tee "$WORK/out.txt"
grep -q "^FAILURES: 0$" "$WORK/out.txt"
