# Multica

Plataforma self-hosted de issues executadas por agentes de código (Claude Code e Codex). Você cria a issue, atribui um agente e ela anda sozinha:

**A fazer → Em andamento → Em revisão → merge**

Cada execução trabalha num worktree isolado no servidor e numa branch própria `mx/<chave>-<n>-<slug>`. O resultado é publicado no remoto. O merge cai na branch que você escolher.

A ideia é ter pouca configuração e mais função. Só existem três coisas para configurar: **agentes**, **skills** e os **repositórios** de cada workspace. Quem pode configurar é definido por perfil. O resto é criar, ordenar e acompanhar issues, no navegador, no tablet ou no celular.

**Roda só na sua máquina.** Não há nuvem do Multica nem telemetria. Os agentes são o `claude` e o `codex` que você já tem logados, o git usa as suas credenciais e o servidor escuta só em `localhost`. Para acessar de fora, a escolha é sua: VPN, túnel ou proxy (veja [Acesso de fora](#acesso-de-fora)). A página `/sobre` explica tudo com capturas de tela.

## Rodar na sua máquina

```bash
./run-local.sh     # Postgres no Docker + servidor nativo com o seu claude/codex/git
```

Abra `http://localhost:8700`. Na primeira vez o script compila o front (npm) e o servidor (Go local ou, sem Go, num container). Requisitos: Docker, git, Node e o `claude` e/ou o `codex` no PATH.

- `./run-local.sh --build`: força recompilar.
- `./run-local.sh --stop`: para o Postgres.
- Os dados ficam em `./data` (clones, worktrees, resumos) e no volume do Postgres `multica-local`.

## Como funciona

| | |
|---|---|
| **Agentes como presets** | Você cria uma vez (runtime, modelo, esforço, teto de US$, instruções e um pacote de skills indexadas) e eles valem para todos os workspaces. Dá para ter vários com o mesmo modelo e papéis diferentes. Em cada issue ou ajuste você escolhe (e troca) o agente. |
| **Vários repositórios** | Um workspace tem quantos repositórios quiser. Cada issue recebe um worktree de cada um (ou só dos escolhidos) e a IA mexe só nos que o pedido exige, guiada pela **descrição** de cada repositório. Só os alterados ganham branch, push e merge. |
| **Chat limpo + resumo** | Toda execução começa do zero. A continuidade vem do **resumo** que o agente reescreve ao terminar (objetivo, o que foi feito, arquivos, decisões, pendências) e do log de commits da branch. O contexto fica pequeno e o custo baixo. Se o agente não escrever o resumo, o servidor gera um automático. |
| **Skills compartilhadas** | Guias em markdown, com scripts opcionais, guardados no banco. Você indexa as skills nos agentes: chamou o agente, vai o pacote dele. Agente e issue guardam só a referência: editou uma vez, vale para todos. `Anexar a todas` inclui a skill em toda execução. No prompt vai só o índice (nome, descrição e caminho); o agente lê a skill inteira quando precisa. |
| **Ajuste por comentário** | Comentário com "Enviar para o agente" vira uma nova execução (pode ser outro agente) no mesmo worktree, recebendo o resumo e o pedido. |
| **Merge seguro** | `--no-ff` num worktree temporário, seguido de push, com destino escolhido por repositório. Branches **protegidas** nunca recebem merge. Com vários repositórios, todos os merges são feitos localmente antes: se um der conflito, **nenhum** é publicado. A issue vai para *Bloqueada* e o botão **Resolver conflito com IA** traz o destino para a branch da issue e pede ao agente para resolver. O merge é recusado enquanto houver marcador de conflito. |
| **Tempo real** | Log do agente ao vivo, quadro e comentários atualizam via SSE para todo mundo que está olhando. |
| **Analytics** | Custo, tokens (entrada, cache, saída), tempo e execuções por dia e por agente. |

Gatilhos do quadro:
- criar uma issue em **A fazer** com agente, ou movê-la para lá, coloca a issue na fila;
- uma issue em **Backlog** não roda;
- mover para **Backlog** ou **Cancelada** interrompe a execução.

## Usuários e permissões

- **Dono:** o primeiro cadastro. Pode tudo, é o único que vê a tela **Permissões** e não pode ser editado nem removido por outra pessoa. Depois dele não existe cadastro público.
- **Perfis:** o dono monta perfis marcando permissões. Cada usuário recebe um perfil em *Usuários*. Permissões disponíveis:
  - issues: criar, editar/mover/comentar, excluir, executar agentes, fazer merge/descartar;
  - agentes e skills: criar, editar, excluir;
  - workspaces: criar, renomear, excluir, ver todos (sem vínculo), vincular pessoas;
  - repositórios: adicionar, editar, remover;
  - usuários: criar, editar (senha, perfil, workspaces), remover;
  - servidor: configurar e-mail.
- **Perfis iniciais:** *Administrador* (tudo) e *Membro* (criar, editar, executar e fazer merge de issues). Mudar um perfil vale na hora para todos que o usam.
- **Workspaces:** quem não tem "ver todos" enxerga só os workspaces em que foi vinculado.
- **Garantia:** a API confere permissão e vínculo em toda rota. Sem permissão a resposta é 403; workspace alheio responde 404. Os menus e botões somem conforme o perfil.

## E-mail de notificação

Quando alguém cria uma issue, todo mundo do workspace recebe um e-mail.

- **Quem recebe:** os vinculados e os admins. Ficam de fora quem criou a issue e quem desligou o e-mail em *Minha conta*.
- **Uma mensagem por issue:** os destinatários vão em cópia oculta.
- **Uma conversa por workspace:** o assunto é sempre `[Multica] <nome do workspace>` e todas as mensagens apontam para a mesma raiz (`In-Reply-To`/`References`). Gmail, Outlook e afins juntam tudo numa conversa por workspace.
- **Configuração no banco:** o SMTP fica na tabela `settings`, não no `.env`. O admin configura em *Usuários e servidor → E-mail de notificação*:
  - servidor, porta, segurança, usuário e senha, remetente e o endereço do Multica usado nos links;
  - atalhos para Gmail e Outlook;
  - botão **Enviar teste para mim**.
- **Senha:** fica no banco e nunca volta para o navegador.
- **Ligar e desligar:** começa desligado, e desligado ninguém recebe. Quando o admin liga, passa a avisar todos que não desligaram no próprio perfil.
- **Gmail:** use uma [senha de app](https://myaccount.google.com/apppasswords).

## Stack

- **Go**: servidor HTTP, fila de execuções no Postgres (`FOR UPDATE SKIP LOCKED`, sobrevive a reinícios), processos dos agentes em grupo próprio (cancelamento mata a árvore inteira), git via binário do sistema. Tudo vira um binário único, com o front embutido.
- **PostgreSQL**: usuários, perfis de acesso, parâmetros (e-mail), workspaces, repositórios por issue, repositórios, agentes, skills, issues, execuções, eventos de log e comentários.
- **React + TypeScript + Vite + Tailwind**: SPA responsiva e instalável (PWA). TanStack Query para o cache, dnd-kit para arrastar no mouse e no toque.
- **Docker**: a imagem traz `git`, `claude` e `codex`. Os agentes rodam como usuário comum.

```
server/
├── cmd/multica/main.go
└── internal/
    ├── api/        rotas JSON, autenticação por sessão, SSE
    ├── runner/     fila, execução, eventos Claude/Codex, prompt, git, merge
    ├── store/      queries Postgres
    ├── db/         pool + migrações embutidas (migrations/*.sql)
    ├── hub/        pub/sub em memória para o SSE
    ├── notify/     e-mail (SMTP) de issue nova
    └── webui/      front compilado (embed)
web/src/
├── pages/          Landing, Board, IssuePage, Analytics, Agents, Skills, WorkspaceSettings, Account, Roles
├── components/     Layout, NewIssue, SearchModal, pickers, ui
└── lib/            api, tipos, consultas, tempo real, formatação
```

## Subir no servidor

```bash
cp .env.example .env          # ajuste POSTGRES_PASSWORD
docker compose up -d --build
```

Acesse `http://localhost:8700` (por padrão o compose publica só em `127.0.0.1`; `MULTICA_BIND=0.0.0.0` no `.env` abre na rede). O primeiro acesso cria a conta do dono.

### Login dos agentes (uma vez)

Os CLIs usam o login feito dentro do container. Ele fica guardado no volume `home`, então sobrevive a rebuilds.

```bash
docker compose exec multica claude                      # rode /login e siga o link
docker compose exec multica codex login --device-auth
```

Também é possível usar chaves de API: coloque `ANTHROPIC_API_KEY` e `OPENAI_API_KEY` no `.env`. Em **Servidor** dá para ver se os dois estão instalados, a versão de cada um e como o git está autenticado.

### Acesso aos repositórios

O servidor clona cada repositório, então precisa de credenciais git:

- **SSH:** gere uma chave dentro do container e cadastre-a como *deploy key* com escrita:
  ```bash
  docker compose exec multica sh -c 'ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub'
  ```
- **HTTPS:** use a URL com token, por exemplo `https://<token>@github.com/org/repo.git`. O token nunca aparece na interface nem nos logs.

Ao salvar um repositório, o Multica roda `git ls-remote`: URL que não seja um repositório git acessível pelo servidor é recusada. Depois ele clona e lista as branches. Rodando com `./run-local.sh`, valem as suas credenciais (chave SSH, credential helper ou `gh auth`).

Escreva uma **descrição** de uma linha em cada repositório. É o que a IA usa para decidir em quais mexer quando o workspace tem vários.

### Acesso direto ao banco

```bash
docker compose --profile admin up -d adminer   # http://localhost:8701 (só local)
```

Servidor `db`, usuário `multica`, senha do `.env`.

### Acesso de fora

Por padrão nada sai da sua máquina. Para usar do celular ou chamar o time, da opção mais fechada para a mais aberta:

- **VPN** (Tailscale, WireGuard): recomendado; nada fica exposto na internet.
- **Rede local:** `MULTICA_ADDR=0.0.0.0:8700 ./run-local.sh` e acesse pelo IP da máquina.
- **Túnel** (Cloudflare Tunnel, ngrok): endereço público; use HTTPS e senhas fortes.
- **Servidor próprio:** veja HTTPS abaixo.

### HTTPS

Coloque um proxy reverso (Caddy, nginx, Traefik) na frente da porta 8700 e defina `MULTICA_SECURE_COOKIE=true`. Com nginx, o SSE precisa de `proxy_buffering off;`; o servidor já manda `X-Accel-Buffering: no`.

## Configuração (variáveis de ambiente)

| Variável | Padrão | |
|---|---|---|
| `DATABASE_URL` | `postgres://multica:multica@localhost:5432/multica` | |
| `MULTICA_ADDR` | `127.0.0.1:8700` (`:8700` no Docker) | `0.0.0.0:8700` abre na rede |
| `MULTICA_DATA` | `./data` (`/data` no Docker) | clones, worktrees, skills em disco |
| `MULTICA_MAX_PARALLEL` | `3` | execuções simultâneas; o resto espera na fila |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | |
| `MULTICA_SECURE_COOKIE` | `false` | `true` atrás de HTTPS |

## Desenvolvimento

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # Postgres em localhost:5432
cd server && go run ./cmd/multica                         # API em :8700 (precisa de Go 1.23)
cd web && npm install && npm run dev                      # front em :5700, com proxy para a API
```

O `npm run build` do `web/` gera o front direto em `server/internal/webui/dist`, que é embutido no binário.

## Custos e segurança

- **Teto por execução:** cada agente pode ter um teto em US$ (`--max-budget-usd`, só no Claude). Modelo e esforço também ficam por agente.
- **Contexto enxuto:** com vários repositórios, o prompt leva só o mapa (nome, descrição, base). As instruções de cada projeto vão para um arquivo que a IA lê só se for mexer naquele repositório.
- **Contexto enviado:** o "Contexto enviado ao agente" em cada execução mostra exatamente o prompt e o system prompt usados.
- **Permissão "Total":** roda o agente sem pedir confirmação (`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`). O isolamento é o worktree, o usuário sem privilégios e o próprio container. Para algo mais conservador, use "Só edições".
- **Arquivos de ambiente:** os `.env` cadastrados no repositório ficam no banco, são escritos no worktree com permissão 600 e nunca são commitados.
