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
| **Chat limpo + README** | Todo pedido abre um chat novo. A continuidade vem do **README da issue**, que o agente reescreve ao terminar (objetivo, o que foi feito por pedido, arquivos, decisões, como testar, pendências), do **histórico de pedidos** que o Multica registra (quando, agente, pedido, resultado, commits) e do log de commits. Os dois vão como anexo para o próximo chat e ficam na aba README da issue. Se o agente não escrever o README, o servidor gera um automático. |
| **Resultado declarado** | Ao terminar, a IA escreve em `$MULTICA_STATUS` se ficou `concluido`, `aguardando: <o que precisa>` ou `incompleto: <por quê>`. Concluído vai para *Em revisão*; os outros vão para *Aguardando você*, com a pergunta como comentário e uma caixa para responder direto ao agente. |
| **Etapas e automações** | O núcleo do Multica; veja [Fluxo, papéis e automações](#fluxo-papéis-e-automações). |
| **Skills compartilhadas** | Guias em markdown, com scripts opcionais, guardados no banco. Você indexa as skills nos agentes: chamou o agente, vai o pacote dele. Agente e issue guardam só a referência: editou uma vez, vale para todos. `Anexar a todas` inclui a skill em toda execução. No prompt vai só o índice (nome, descrição e caminho); o agente lê a skill inteira quando precisa. |
| **Ajuste por comentário** | Comentário com "Enviar para o agente" vira uma nova execução (pode ser outro agente) no mesmo worktree, recebendo o resumo e o pedido. |
| **Merge seguro** | `--no-ff` num worktree temporário, seguido de push, com destino escolhido por repositório. Com vários repositórios, todos os merges são feitos localmente antes: se um der conflito, **nenhum** é publicado. A issue vai para *Bloqueada* e o botão **Resolver conflito com IA** traz o destino para a branch da issue e pede ao agente para resolver. O merge é recusado enquanto houver marcador de conflito. |
| **Tempo real** | Log do agente ao vivo, quadro e comentários atualizam via SSE para todo mundo que está olhando. |
| **Analytics** | Custo, tokens (entrada, cache, saída), tempo e execuções por dia e por agente. |

Caminho de uma issue:
- criar em **A fazer** com agente, ou mover para lá, coloca na fila; todo pedido novo (issue, ajuste, resposta, regra) leva a issue para **Em andamento** na hora;
- a IA terminou → **Em revisão**; precisa de alguém ou não terminou → **Aguardando você**; falhou ou deu conflito → **Bloqueada**;
- em **Em revisão**, o botão **✓ Aprovar** leva para **Concluída**, onde por padrão a regra faz o merge (troque por "Abrir PR" se preferir);
- uma issue em **Backlog** não roda; mover para **Backlog** ou **Cancelada** interrompe a execução.

## Fluxo, papéis e automações

Usuários e perfis são **globais**; o acesso a workspaces, não. O fluxo de cada workspace fica em *Fluxo e automações*.

**Nada é fixo por etapa.** Todo workspace nasce com um **fluxo padrão** (Backlog → A fazer → Em andamento → Aguardando você → Em revisão → Bloqueada → Concluída → Cancelada) e com **regras padrão** que fazem o que antes era embutido no código. Tudo pode ser renomeado, reordenado, desligado ou apagado, e dá para montar um fluxo do zero. A etapa em si é só **nome, lugar no fluxo e se fica em paralelo** com a anterior; removida, as issues dela vão para a primeira etapa.

As regras padrão (função `seed_workflow` no banco, migração 016):
- **A fazer, ao entrar:** rodar o agente da issue (sem agente, fica como tarefa manual; sem repositório, a regra avisa e a issue fica onde está).
- **Agente começou** (pedido pelo quadro, comentário ou resposta): mover para Em andamento.
- **Execução terminou**, estando em Em andamento: concluída → Em revisão; precisa de você ou incompleta → Aguardando você; falhou → Bloqueada; parada → Backlog.
- **Backlog e Cancelada, ao entrar:** parar o agente.
- **Merge feito** → Concluída; **conflito no merge** → Bloqueada.
- **Concluída** encerra a issue como resolvida e **Cancelada** como cancelada (regra de acesso "Encerrar a issue"); é isso que o analytics conta.
- **Em revisão:** 1 aprovação → Concluída. **Concluída, ao entrar:** merge. **Aguardando você, ao entrar:** e-mail para quem pediu.

O filtro **"a issue está na etapa"** faz uma regra de gatilho geral (agente terminou, merge…) valer só a partir de certas etapas. **Rodar agente** pode **esperar terminar na etapa** (a issue fica ali e as regras seguintes rodam depois, ex.: revisão por IA) ou ser um pedido normal (as regras de "agente começou/terminou" decidem a etapa).

**O analytics segue o fluxo que você montou:** cada etapa ganha um tipo pelas regras (o agente trabalha ali, espera alguém responder à IA, tem aprovação, encerra), e daí saem "onde o tempo vai", o tipo de cada etapa no tempo por etapa e o tempo de resposta por pessoa.

**Regras de acesso** (*+ Regra → Sempre: acesso e travas*) valem o tempo todo enquanto a issue está na etapa; várias se somam:
- **Quem mexe nas issues desta etapa** (perfis e/ou pessoas): editar, comentar, rodar agente, tirar dali.
- **Quem pode trazer issues para cá.**
- **Travas:** campos que ninguém altera ali (título, descrição, prioridade, labels, agente, repositórios, responsável).
- **Requisitos para entrar:** ter agente, responsável, descrição ou alterações de código.
- **Limite** de issues ao mesmo tempo.
- **Somente leitura:** entrou, ninguém mexe mais (só o dono).
- **Aprovação:** a issue ganha o botão *✓ Aprovar*; ela só segue quando **N pessoas diferentes** aprovarem (cada uma conta uma vez) e vai sozinha para o destino escolhido. Ex.: com 2, o tech lead aprova (1 de 2) e a issue espera; o PO aprova (2 de 2) e ela segue. *Em revisão* nasce com 1 aprovação → *Concluída*.
- **Responsáveis da etapa** (destinatários de e-mail).

Ex.: Estagiário e Júnior podem ter o **mesmo perfil de permissões**, mas a Triagem só aceita o Estagiário e o Desenvolvimento só o Júnior: cada um mexe na sua etapa. O dono passa por tudo.

**Telas por permissão.** Cada tela tem um "ver" (Analytics, Fluxo, Repositórios e pessoas, Agentes, Skills, Usuários). A tela aparece com o "ver" ou com qualquer permissão de mexer nela; sem nenhuma, some do menu e o endereço bloqueia; só com o "ver", abre em modo leitura. Em *Usuários*, quem pode ver abre o **perfil** de cada pessoa: o que o perfil dela permite e, em cada workspace em comum, em que etapas ela mexe, traz issues, aprova ou é responsável, regras que a citam e issues abertas, criadas e resolvidas.

**Permissões finas** (perfil): criar, editar texto, mover, comentar, prioridade, labels, agente, repositórios, responsável, executar, aprovar, merge, excluir, labels do workspace, configurar e copiar o fluxo. Ex.: um perfil que só cria issues não escolhe agente nem prioridade. Cada issue devolve o que a pessoa pode fazer ali (`caps`); a tela trava o resto e o servidor confere de novo.

**Mapa do fluxo.** A aba *Mapa do fluxo* desenha o processo de cima para baixo: o caminho do quadro, uma seta por regra de mover (com a condição, ex.: "Urgente/Alta"), as aprovações e, se quiser, o que o sistema faz sozinho (agente começa, IA concluiu, precisa de você, falhou). **Etapas em paralelo** ("ao lado da anterior") ficam lado a lado no mapa e dividem a mesma coluna no quadro, uma embaixo da outra. A ordem das colunas do quadro vem só do fluxo.

**Ordem das regras.** As regras de uma etapa rodam de cima para baixo, na ordem que você arrastar. Ações rápidas (notificar, comentar, definir campos) seguem na hora; script, merge e PR esperam terminar; **rodar agente** numa regra de etapa também espera: a issue fica na etapa enquanto o agente trabalha e a próxima regra só roda quando ele termina (se ele precisar de alguém, a issue vai para *Aguardando você*; se falhar, para *Bloqueada* ou a etapa "se falhar"). **Mover** tira a issue da etapa, então deixe por último — a tela avisa quando não está. Ex.: *avisar que chegou → agente revisa → avisar que terminou → mover para QA*.

**Regras** = gatilho + condições + ação. Gatilhos: entrar, sair ou ficar parada X horas numa etapa; issue criada; comentário; execução terminou (concluída, aguardando, incompleta, falhou); responsável definido; prioridade trocada; custo acima de US$ X. Condições: prioridade, labels, agente, perfil de quem causou. Ações: notificar por e-mail (quem pediu, quem criou, responsável, responsáveis da etapa, time, só administradores, perfis ou usuários escolhidos — nunca e-mail digitado), webhook, comentar, mover, definir responsável (fixo, quem criou, quem pediu ou distribuir para quem tem menos issues num grupo), prioridade, label, agente, rodar agente, abrir PR, merge e script. Cada ação vira comentário na issue; loops param sozinhos.

**Copiar o fluxo** para outro workspace mostra antes o que muda: perfis e agentes vão iguais (são globais), pessoas sem acesso ao destino saem das listas, labels são recriadas pelo nome e regras que ficariam sem ninguém vão desativadas. A tela de fluxo também alerta quando alguém perde o acesso depois.

**Skills** se vinculam a todas as issues, a agentes escolhidos ou a nenhum; o agente mostra as skills do pacote dele.

A chave do workspace (prefixo das issues) não muda depois de criada.

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

## Idioma e tema

- **Português (Brasil) e inglês.** Na primeira visita vale o idioma do navegador. Dá para trocar no rodapé do menu, no login, na página inicial ou em *Minha conta → Aparência e idioma*. As mensagens de erro do servidor seguem o idioma da tela (o front manda `X-Lang`).
- **Tema claro, escuro ou do sistema**, nos mesmos lugares. Fica guardado no navegador e é aplicado antes de a página carregar, sem piscar.
- **Para traduzir um texto novo:** no front, use `t('texto em português')`, com `{0}`, `{1}` para valores, e coloque a tradução em `web/src/locales/en.ts`. No servidor, use `bad(...)` ou `forbidden(...)` e coloque a tradução em `server/internal/api/i18n.go`. O que não tiver tradução aparece em português.

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

Testes de ponta a ponta (Docker; sobe uma stack isolada na porta 18700 com repositórios git de teste e um agente simulado): `tests/e2e/run.sh` (ou `--no-build` para reaproveitar a imagem).

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # Postgres em localhost:5432
cd server && go run ./cmd/multica                         # API em :8700 (precisa de Go 1.23)
cd web && npm install && npm run dev                      # front em :5700, com proxy para a API
```

O `npm run build` do `web/` gera o front direto em `server/internal/webui/dist`, que é embutido no binário.

## Custos e segurança

- **Teto por execução:** cada agente pode ter um teto em US$ (`--max-budget-usd`, só no Claude). Modelo e esforço também ficam por agente.
- **Contexto enxuto:** com vários repositórios, o prompt leva só o mapa (nome, descrição, base). Instruções de projeto ficam no próprio repositório (`CLAUDE.md`, `AGENTS.md`), que o agente já lê.
- **Contexto enviado:** o "Contexto enviado ao agente" em cada execução mostra exatamente o prompt e o system prompt usados.
- **Isolamento:** o agente roda sem pedir confirmação, mas dentro do sandbox do próprio CLI (bubblewrap no Linux): grava **só** na pasta da issue e no cache de pacotes do Multica (`data/cache`, para `npm`, `pip`, `go`…); o resto do disco fica somente leitura. A rede fica liberada para instalar dependências. Claude: `--permission-mode acceptEdits` + `sandbox` nas settings; Codex: `-s workspace-write` com rede. Sem `bwrap` no servidor (por exemplo, num container sem user namespaces) o agente roda sem sandbox e o log da execução avisa; nesse caso o isolamento é o do container.
- **Configuração mínima:** repositório é URL, branch de onde desenvolver e branch de merge (mais uma descrição opcional). Dependências, `.env` e testes ficam por conta do agente, dentro do worktree.
