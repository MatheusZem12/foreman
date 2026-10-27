import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight, Bot, BookOpen, Eye, FolderGit2, GitMerge, Globe, HardDrive, Laptop, Lock, Mail, MessageSquareText,
  ScrollText, ShieldCheck, Sparkles, Terminal, Wallet
} from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/queries';

// Página inicial: o que é, como funciona e como começar. Pública (não precisa de login).
export function Landing() {
  const { data: me } = useMe();
  const { data: setup } = useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup'), enabled: !me });
  const cta = me ? { to: '/', label: 'Abrir o Multica' } : setup?.needsSetup ? { to: '/login', label: 'Criar a conta de dono' } : { to: '/login', label: 'Entrar' };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-bg">
      <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="font-semibold">Multica</span>
          <nav className="ml-6 hidden gap-5 text-sm text-dim md:flex">
            <a href="#como" className="hover:text-fg">Como funciona</a>
            <a href="#recursos" className="hover:text-fg">Recursos</a>
            <a href="#local" className="hover:text-fg">Local</a>
            <a href="#comecar" className="hover:text-fg">Começar</a>
          </nav>
          <Link to={cta.to} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent/85">
            {cta.label} <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-96 max-w-3xl rounded-full bg-accent/20 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-14 text-center md:pt-20">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
            <Lock className="size-3" /> Roda só na sua máquina · nada é publicado
          </span>
          <h1 className="mx-auto mt-5 max-w-3xl text-balance text-3xl font-semibold leading-tight tracking-tight md:text-5xl">
            Você escreve a issue. <span className="text-accent">O agente entrega a branch.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-balance text-base text-dim md:text-lg">
            Um quadro de issues em que cada tarefa é executada pelo Claude Code ou pelo Codex: numa cópia isolada do código,
            em quantos repositórios precisar, com resumo, diff e merge na branch que você escolher.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-2">
            <Link to={cta.to} className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-5 font-medium text-white hover:bg-accent/85">
              {cta.label} <ArrowRight className="size-4" />
            </Link>
            <a href="#como" className="inline-flex h-10 items-center rounded-lg border border-line bg-card px-5 text-dim hover:bg-hover hover:text-fg">Ver como funciona</a>
          </div>
          <Shot src="/shots/board.jpg" alt="Quadro de issues" className="mx-auto mt-12 max-w-5xl" />
        </div>
      </section>

      {/* Como funciona */}
      <section id="como" className="border-t border-line/60">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle kicker="Fluxo" title="Da issue ao merge em quatro passos" />
          <ol className="mt-10 grid gap-4 md:grid-cols-4">
            {[
              [ScrollText, 'Crie a issue', 'Título, descrição e o agente. Em "A fazer" ela entra na fila na hora.'],
              [FolderGit2, 'O agente trabalha isolado', 'Cada issue ganha um worktree de cada repositório, numa branch própria. Seu checkout nunca é tocado.'],
              [Eye, 'Revise', 'Log ao vivo, resumo do que foi feito e diff por repositório. Peça ajustes com um comentário.'],
              [GitMerge, 'Merge', 'Merge --no-ff na branch que você escolher. Em conflito nada é publicado, e a IA pode resolver.']
            ].map(([Icon, title, text], i) => {
              const I = Icon as typeof Bot;
              return (
                <li key={i} className="rounded-xl border border-line bg-panel p-5">
                  <div className="flex items-center gap-2">
                    <span className="grid size-7 place-items-center rounded-md bg-accent/15 text-xs font-semibold text-accent">{i + 1}</span>
                    <I className="size-4 text-mute" />
                  </div>
                  <h3 className="mt-3 font-medium">{title as string}</h3>
                  <p className="mt-1 text-sm text-dim">{text as string}</p>
                </li>
              );
            })}
          </ol>
          <div className="mt-10 grid items-center gap-8 md:grid-cols-2">
            <Shot src="/shots/issue.jpg" alt="Página da issue com log do agente" />
            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Chat limpo, contexto enxuto</h3>
              <p className="text-dim">
                Toda execução começa do zero. O que liga uma execução à outra é o <b className="text-fg">resumo</b> que o próprio agente reescreve ao terminar
                (objetivo, o que fez, decisões, pendências) mais os commits da branch. Um pedido de ajuste leva só isso, não a conversa inteira:
                menos tokens, menos custo e nada de contexto estragado.
              </p>
              <p className="text-dim">
                Skills e instruções de cada repositório entram como <b className="text-fg">índice</b> (nome, descrição e caminho). O agente só lê o arquivo inteiro quando precisa.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Recursos */}
      <section id="recursos" className="border-t border-line/60 bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle kicker="Recursos" title="Pouca configuração, muita função" />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={FolderGit2} title="Vários repositórios por workspace">
              Front, API, mobile… A issue recebe todos e a IA decide em quais mexer, guiada pela descrição de cada um. Só os alterados ganham branch e merge.
            </Feature>
            <Feature icon={Bot} title="Agentes como presets">
              Runtime (Claude ou Codex), modelo, esforço, teto de custo, instruções e um pacote de skills. Mesmo modelo com papéis diferentes: dev, revisor, testes.
            </Feature>
            <Feature icon={BookOpen} title="Skills compartilhadas">
              Escreva uma vez, indexe em quantos agentes quiser. Editou a skill, todos os agentes passam a usar a versão nova.
            </Feature>
            <Feature icon={MessageSquareText} title="Ajuste por comentário">
              "Troque o botão para verde": o comentário vira uma nova execução, com o agente que você escolher, no mesmo worktree.
            </Feature>
            <Feature icon={ShieldCheck} title="Permissões por perfil">
              O dono monta perfis (criar, editar e excluir issues, agentes, skills, repositórios…) e cada pessoa vê só os workspaces dela.
            </Feature>
            <Feature icon={Mail} title="Aviso por e-mail">
              Issue nova avisa o workspace inteiro numa conversa só por workspace. O dono liga; quem não quiser desliga no perfil.
            </Feature>
            <Feature icon={Wallet} title="Custo sob controle">
              Analytics de custo, tokens e tempo por dia e por agente. Teto em US$ por execução no Claude.
            </Feature>
            <Feature icon={GitMerge} title="Merge seguro">
              Branches protegidas nunca recebem merge. Vários repositórios: ou todos os merges passam, ou nada é publicado.
            </Feature>
            <Feature icon={Laptop} title="Celular e tablet">
              Interface responsiva e instalável (PWA). Arraste cartões no toque, acompanhe o log de onde estiver.
            </Feature>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <Shot src="/shots/agents.jpg" alt="Agentes com skills" />
            <Shot src="/shots/permissions.jpg" alt="Perfis de permissão" />
          </div>
          <Shot src="/shots/analytics.jpg" alt="Analytics: issues por mês, custo, agentes e modelos" className="mt-4" />
        </div>
      </section>

      {/* Local */}
      <section id="local" className="border-t border-line/60">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <div className="grid gap-10 md:grid-cols-2">
            <div>
              <SectionTitle kicker="Privacidade" title="Local por padrão. Publicar é escolha sua." align="left" />
              <p className="mt-4 text-dim">
                O Multica é um programa que roda no seu computador (ou num servidor seu). Não existe nuvem do Multica, conta externa nem telemetria.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                <Item icon={HardDrive}>Issues, usuários e histórico ficam no <b>seu</b> Postgres; clones e worktrees, na pasta de dados local.</Item>
                <Item icon={Terminal}>Os agentes são o <b>seu</b> <code>claude</code> e o <b>seu</b> <code>codex</code>, com o login que você já tem.</Item>
                <Item icon={FolderGit2}>O git usa as <b>suas</b> credenciais (SSH, token ou gh). O código só vai para os remotos que você cadastrar.</Item>
                <Item icon={Lock}>Por padrão o servidor escuta só em <code>localhost</code>: ninguém de fora acessa.</Item>
              </ul>
            </div>
            <div className="rounded-2xl border border-line bg-panel p-6">
              <div className="flex items-center gap-2 font-medium"><Globe className="size-4 text-accent" /> Quer acessar do celular ou chamar o time?</div>
              <p className="mt-2 text-sm text-dim">Só se você quiser. Algumas opções, da mais fechada para a mais aberta:</p>
              <div className="mt-4 space-y-3 text-sm">
                <Option title="VPN (Tailscale, WireGuard)" tag="recomendado">Celular e colegas entram na sua rede privada; nada fica exposto na internet.</Option>
                <Option title="Rede local">Suba com <code>MULTICA_ADDR=0.0.0.0:8700</code> e acesse pelo IP da máquina, na mesma Wi-Fi.</Option>
                <Option title="Túnel (Cloudflare Tunnel, ngrok)">Um endereço público temporário. Use com HTTPS e senhas fortes.</Option>
                <Option title="Servidor próprio">Docker Compose com proxy reverso (Caddy, nginx) e <code>MULTICA_SECURE_COOKIE=true</code>.</Option>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Começar */}
      <section id="comecar" className="border-t border-line/60 bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <SectionTitle kicker="Começar" title="Em cinco minutos" />
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            <Step n={1} title="Suba o Multica">
              <Code>{`# na pasta do projeto
./run-local.sh           # Postgres no Docker + servidor nativo
# ou, tudo em container:
docker compose up -d --build`}</Code>
              <p>Acesse <code>http://localhost:8700</code>. O primeiro cadastro vira o <b>dono</b>: pode tudo e define as permissões.</p>
            </Step>
            <Step n={2} title="Confira git e agentes">
              <p>Em <b>Servidor</b>: o Claude Code e o Codex precisam aparecer como instalados, e o git com chave SSH, credential helper ou <code>gh</code> autenticado.</p>
              <Code>{`claude          # /login, uma vez
codex login
gh auth login   # ou uma chave SSH`}</Code>
            </Step>
            <Step n={3} title="Workspace e repositórios">
              <p>Crie um workspace e adicione os repositórios git (o Multica testa o acesso ao salvar). Escreva uma <b>descrição</b> de uma linha em cada um: é com ela que a IA escolhe onde mexer.</p>
            </Step>
            <Step n={4} title="Agentes e skills">
              <p>Crie skills (guias e scripts), crie agentes e indexe as skills neles. Ex.: "Dev Sonnet" com as skills de padrão de código e testes; "Revisor" com a de checklist.</p>
            </Step>
            <Step n={5} title="Pessoas e perfis">
              <p>Em <b>Permissões</b>, monte os perfis. Em <b>Usuários</b>, crie as contas, escolha o perfil e os workspaces de cada pessoa.</p>
            </Step>
            <Step n={6} title="Primeira issue">
              <p>Aperte <kbd className="rounded border border-line px-1">C</kbd>, descreva o que quer, escolha o agente e deixe em <b>A fazer</b>. Acompanhe o log, revise o diff e faça o merge.</p>
            </Step>
          </div>
          <div className="mt-12 flex justify-center">
            <Link to={cta.to} className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-6 font-medium text-white hover:bg-accent/85">
              <Sparkles className="size-4" /> {cta.label}
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-6 text-xs text-mute">
          <img src="/icon.svg" alt="" className="size-4" /> Multica · self-hosted, local por padrão
          <span className="ml-auto">Go · PostgreSQL · React</span>
        </div>
      </footer>
    </div>
  );
}

function SectionTitle({ kicker, title, align = 'center' }: { kicker: string; title: string; align?: 'center' | 'left' }) {
  return (
    <div className={align === 'center' ? 'text-center' : ''}>
      <div className="text-xs font-medium uppercase tracking-wider text-accent">{kicker}</div>
      <h2 className="mt-2 text-balance text-2xl font-semibold tracking-tight md:text-3xl">{title}</h2>
    </div>
  );
}

function Feature({ icon: Icon, title, children }: { icon: typeof Bot; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5 transition-colors hover:border-accent/40">
      <Icon className="size-5 text-accent" />
      <h3 className="mt-3 font-medium">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-dim">{children}</p>
    </div>
  );
}

function Item({ icon: Icon, children }: { icon: typeof Bot; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-dim">
      <Icon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
      <span>{children}</span>
    </li>
  );
}

function Option({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <div className="flex items-center gap-2 font-medium">{title}{tag && <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] text-emerald-300">{tag}</span>}</div>
      <p className="mt-0.5 text-dim">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-full bg-accent text-xs font-semibold text-white">{n}</span>
        <h3 className="font-medium">{title}</h3>
      </div>
      <div className="mt-3 space-y-2 text-sm text-dim">{children}</div>
    </div>
  );
}

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-relaxed text-fg">{children}</pre>
);

// Captura de tela com moldura de janela; some se a imagem não existir.
function Shot({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <div className={`overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/40 ${className}`}>
      <div className="flex h-7 items-center gap-1.5 border-b border-line px-3">
        <span className="size-2.5 rounded-full bg-red-400/60" /><span className="size-2.5 rounded-full bg-amber-400/60" /><span className="size-2.5 rounded-full bg-emerald-400/60" />
      </div>
      <img src={src} alt={alt} loading="lazy" onError={() => setOk(false)} className="block w-full" />
    </div>
  );
}
