#!/usr/bin/env bash
# Roda o Multica na sua máquina, usando o claude, o codex e o git que você já
# tem instalados e autenticados. Só o Postgres roda no Docker.
#
#   ./run-local.sh            sobe (compila se precisar) em http://localhost:8700
#   ./run-local.sh --build    força recompilar front e servidor
#   ./run-local.sh --stop     para o Postgres local
#
# Variáveis úteis: MULTICA_ADDR (padrão 127.0.0.1:8700; 0.0.0.0:8700 abre na
# rede), MULTICA_DATA (padrão ./data), MULTICA_MAX_PARALLEL (padrão 3).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$PWD
PROJECT=multica-local
PG_PORT=${MULTICA_PG_PORT:-5432}
compose() { docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.dev.yml "$@"; }

if [[ "${1:-}" == "--stop" ]]; then
  compose stop db
  exit 0
fi

need() { command -v "$1" >/dev/null || { echo "✗ falta o comando '$1'"; exit 1; }; }
need docker
need git
for bin in claude codex; do
  command -v "$bin" >/dev/null && echo "✓ $bin: $($bin --version 2>/dev/null | head -1)" || echo "! $bin não encontrado no PATH (agentes $bin não vão rodar)"
done

# 1. Postgres (só em 127.0.0.1)
echo "→ Postgres em 127.0.0.1:$PG_PORT"
compose up -d --wait db >/dev/null

# 2. Front
if [[ "${1:-}" == "--build" || ! -f server/internal/webui/dist/index.html ]]; then
  need npm
  echo "→ Compilando o front"
  (cd web && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build >/dev/null)
fi

# 3. Servidor (Go local se houver; senão compila num container e roda nativo)
if [[ "${1:-}" == "--build" || ! -x bin/multica || -n "$(find server -name '*.go' -newer bin/multica -print -quit)" || -n "$(find server/internal/webui/dist -newer bin/multica -print -quit)" ]]; then
  echo "→ Compilando o servidor"
  mkdir -p bin "$HOME/.cache/multica-go"
  if command -v go >/dev/null; then
    (cd server && CGO_ENABLED=0 go build -o "$ROOT/bin/multica" ./cmd/multica)
  else
    docker run --rm -u "$(id -u):$(id -g)" -v "$ROOT/server:/src" -v "$ROOT/bin:/out" -w /src \
      -v "$HOME/.cache/multica-go:/tmp/gocache" -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gocache/gopath -e GOFLAGS=-buildvcs=false -e CGO_ENABLED=0 \
      golang:1.23 go build -o /out/multica ./cmd/multica
  fi
fi

# 4. Roda
export DATABASE_URL="postgres://multica:${POSTGRES_PASSWORD:-multica}@127.0.0.1:$PG_PORT/multica?sslmode=disable"
export MULTICA_DATA="${MULTICA_DATA:-$ROOT/data}"
export MULTICA_ADDR="${MULTICA_ADDR:-127.0.0.1:8700}"
echo "→ Multica em http://${MULTICA_ADDR/0.0.0.0/localhost}  (Ctrl+C para parar)"
exec ./bin/multica
