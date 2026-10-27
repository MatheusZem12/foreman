# 1) front-end
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx tsc -b && npx vite build --outDir /dist --emptyOutDir

# 2) servidor Go (com o front embutido)
FROM golang:1.23-bookworm AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN rm -rf internal/webui/dist
COPY --from=web /dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /multica ./cmd/multica

# 3) runtime: git + Claude Code + Codex. Os agentes rodam como usuário comum
#    (o Claude Code recusa --dangerously-skip-permissions como root).
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates bash curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} && npm cache clean --force
COPY --from=server /multica /usr/local/bin/multica
RUN mkdir -p /data && chown node:node /data
ENV MULTICA_DATA=/data MULTICA_ADDR=:8700 HOME=/home/node
USER node
WORKDIR /home/node
VOLUME ["/data", "/home/node"]
EXPOSE 8700
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:8700/api/health || exit 1
CMD ["multica"]
