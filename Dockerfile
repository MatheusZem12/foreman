# 1) front-end
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx tsc -b && npx vite build --outDir /dist --emptyOutDir

# 2) Go server (with the front end embedded)
FROM golang:1.23-bookworm AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN rm -rf internal/webui/dist
COPY --from=web /dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /foreman ./cmd/foreman

# 3) runtime: git + Claude Code + Codex + Gemini CLI. The agents run as a regular user
#    (Claude Code refuses --dangerously-skip-permissions as root).
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates bash curl ripgrep procps bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG GEMINI_CLI_VERSION=latest
# AGENT_CLIS=none: the image ships no AI CLI; the server uses the ones installed in the
# home of the user it runs as (mounted, with that user's PATH set in the compose file).
ARG AGENT_CLIS=all
RUN if [ "$AGENT_CLIS" != "none" ]; then \
      npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} @google/gemini-cli@${GEMINI_CLI_VERSION} && npm cache clean --force; \
    fi
COPY --from=server /foreman /usr/local/bin/foreman
RUN mkdir -p /data && chown node:node /data
ENV FOREMAN_DATA=/data FOREMAN_ADDR=:8700 HOME=/home/node
USER node
WORKDIR /home/node
VOLUME ["/data", "/home/node"]
EXPOSE 8700
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:8700/api/health || exit 1
CMD ["foreman"]
