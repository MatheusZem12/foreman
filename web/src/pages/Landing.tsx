import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowRight, BarChart3, Bot, Hand, Workflow, BookOpen, Check, CheckCircle2, Copy, Eye, FolderGit2, GitMerge, Globe, HardDrive, Laptop,
  LayoutGrid, Lock, Mail, MessageSquareText, ScrollText, ShieldCheck, Sparkles, Terminal, Wallet
} from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/queries';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Página inicial: o que é, como funciona e como começar. Pública (não precisa de login).
export function Landing() {
  const { data: me } = useMe();
  const { data: setup } = useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup'), enabled: !me });
  const cta = me ? { to: '/', label: 'Abrir o Multica' } : setup?.needsSetup ? { to: '/login', label: 'Criar a conta de dono' } : { to: '/login', label: 'Entrar' };
  const scroller = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  // Elementos com data-reveal entram suavemente quando aparecem na tela.
  useEffect(() => {
    const els = scroller.current!.querySelectorAll<HTMLElement>('[data-reveal]');
    if (reduced() || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? el.scrollTop / max : 0);
  };

  return (
    <div ref={scroller} onScroll={onScroll} className="landing h-full overflow-y-auto overflow-x-hidden scroll-smooth bg-bg">
      <header className={clsx('sticky top-0 z-30 transition-colors duration-300', progress > 0.005 ? 'border-b border-white/[0.06] bg-bg/70 backdrop-blur-xl' : 'border-b border-transparent')}>
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <img src="/icon.svg" alt="" className="size-6" />
          <span className="font-semibold tracking-tight">Multica</span>
          <nav className="ml-6 hidden gap-1 text-sm text-dim md:flex">
            {[['#como', 'Como funciona'], ['#telas', 'Telas'], ['#recursos', 'Recursos'], ['#local', 'Local'], ['#comecar', 'Começar']].map(([href, label]) => (
              <a key={href} href={href} className="rounded-md px-2.5 py-1 transition-colors hover:bg-white/[0.05] hover:text-fg">{label}</a>
            ))}
          </nav>
          <Link to={cta.to} className="btn-shine ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-b from-accent to-accent/80 px-3 text-sm font-medium text-white shadow-[0_6px_20px_-8px_rgb(var(--accent)/0.9)] transition hover:brightness-110">
            {cta.label} <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="absolute inset-x-0 bottom-[-1px] h-px origin-left bg-gradient-to-r from-accent via-fuchsia-400 to-sky-400" style={{ transform: `scaleX(${progress})` }} />
      </header>

      {/* Hero */}
      <section className="relative -mt-14 overflow-hidden pt-14">
        <div className="hero-grid pointer-events-none absolute inset-0" />
        <div className="blob pointer-events-none absolute -top-32 left-1/2 h-[28rem] w-[46rem] -translate-x-[70%] rounded-full bg-accent/25 blur-[110px]" />
        <div className="blob blob-2 pointer-events-none absolute -top-10 left-1/2 h-80 w-[30rem] -translate-x-[5%] rounded-full bg-sky-500/15 blur-[110px]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 text-center md:pt-24">
          <span data-reveal className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] py-1 pl-1.5 pr-3 text-xs text-emerald-300">
            <span className="relative grid size-5 place-items-center rounded-full bg-emerald-400/15">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/20 [animation-duration:2.4s]" />
              <Lock className="size-3" />
            </span>
            Roda só na sua máquina · nada é publicado
          </span>
          <h1 data-reveal style={{ '--d': '80ms' } as React.CSSProperties} className="mx-auto mt-6 max-w-4xl text-balance text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.035em] md:text-6xl">
            Você escreve a issue.<br className="hidden sm:block" /> <span className="text-gradient">O agente entrega a branch.</span>
          </h1>
          <p data-reveal style={{ '--d': '160ms' } as React.CSSProperties} className="mx-auto mt-5 max-w-2xl text-balance text-base leading-relaxed text-dim md:text-lg">
            Um quadro de issues em que cada tarefa é executada pelo Claude Code ou pelo Codex: numa cópia isolada do código,
            em quantos repositórios precisar, com resumo, diff e merge na branch que você escolher.
          </p>
          <div data-reveal style={{ '--d': '240ms' } as React.CSSProperties} className="mt-8 flex flex-wrap justify-center gap-2.5">
            <Link to={cta.to} className="btn-shine group inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-b from-accent to-accent/80 px-5 font-medium text-white shadow-[0_10px_30px_-10px_rgb(var(--accent)/0.9)] transition hover:brightness-110">
              {cta.label} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a href="#como" className="inline-flex h-11 items-center rounded-xl border border-white/10 bg-white/[0.03] px-5 text-dim backdrop-blur transition hover:border-white/20 hover:bg-white/[0.06] hover:text-fg">Ver como funciona</a>
          </div>
          <div data-reveal style={{ '--d': '360ms' } as React.CSSProperties} className="mx-auto mt-14 max-w-5xl">
            <FlowDemo />
          </div>
        </div>
      </section>

      <Marquee />

      {/* Como funciona */}
      <section id="como" className="relative scroll-mt-14">
        <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
          <SectionTitle kicker="Fluxo" title="Da issue ao merge em quatro passos" />
          <ol className="relative mt-12 grid gap-4 md:grid-cols-4">
            <div className="pointer-events-none absolute left-[12%] right-[12%] top-[34px] hidden h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent md:block" />
            {([
              [ScrollText, 'Crie a issue', 'Título, descrição e o agente. Em "A fazer" ela entra na fila na hora.'],
              [FolderGit2, 'O agente trabalha isolado', 'Cada issue ganha um worktree de cada repositório, numa branch própria. Seu checkout nunca é tocado.'],
              [Eye, 'Revise', 'Log ao vivo, resumo do que foi feito e diff por repositório. Peça ajustes com um comentário.'],
              [GitMerge, 'Merge', 'Merge --no-ff na branch que você escolher. Em conflito nada é publicado, e a IA pode resolver.']
            ] as const).map(([Icon, title, text], i) => (
              <li key={i} data-reveal style={{ '--d': `${i * 90}ms` } as React.CSSProperties} className="spot relative rounded-2xl border border-white/[0.07] bg-panel p-5" onMouseMove={spot}>
                <div className="flex items-center gap-3">
                  <span className="relative grid size-9 place-items-center rounded-xl border border-accent/30 bg-gradient-to-b from-accent/25 to-accent/5 text-accent">
                    <Icon className="size-[18px]" />
                  </span>
                  <span className="font-mono text-xs text-mute">0{i + 1}</span>
                </div>
                <h3 className="mt-4 font-medium">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-dim">{text}</p>
              </li>
            ))}
          </ol>

          <div className="mt-16 grid items-center gap-10 md:grid-cols-2">
            <div data-reveal><Shot src="/shots/issue.jpg" alt="Página da issue com log do agente" tilt /></div>
            <div data-reveal style={{ '--d': '120ms' } as React.CSSProperties} className="space-y-4">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent"><Sparkles className="size-3" /> Contexto enxuto</span>
              <h3 className="text-2xl font-semibold tracking-tight">Chat limpo a cada execução</h3>
              <p className="leading-relaxed text-dim">
                Toda execução começa do zero. O que liga uma execução à outra é o <b className="text-fg">resumo</b> que o próprio agente reescreve ao terminar
                (objetivo, o que fez, decisões, pendências) mais os commits da branch. Um pedido de ajuste leva só isso, não a conversa inteira.
              </p>
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[['menos', 'tokens'], ['menos', 'custo'], ['zero', 'contexto estragado']].map(([a, b]) => (
                  <div key={b} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                    <div className="text-xs text-mute">{a}</div>
                    <div className="text-sm font-medium">{b}</div>
                  </div>
                ))}
              </div>
              <p className="text-sm leading-relaxed text-dim">
                Skills e instruções de cada repositório entram como <b className="text-fg">índice</b> (nome, descrição e caminho). O agente só lê o arquivo inteiro quando precisa.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Telas */}
      <section id="telas" className="relative scroll-mt-14 overflow-hidden border-y border-white/[0.06] bg-panel/40">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
        <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
          <SectionTitle kicker="Telas" title="Tudo num lugar só" />
          <div data-reveal className="mt-10"><Gallery /></div>
        </div>
      </section>

      {/* Recursos */}
      <section id="recursos" className="scroll-mt-14">
        <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
          <SectionTitle kicker="Recursos" title="Pouca configuração, muita função" />
          <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([icon, title, text], i) => (
              <Feature key={title} icon={icon} title={title} delay={(i % 3) * 80}>{text}</Feature>
            ))}
          </div>
        </div>
      </section>

      {/* Local */}
      <section id="local" className="relative scroll-mt-14 overflow-hidden border-y border-white/[0.06] bg-panel/40">
        <div className="pointer-events-none absolute -right-40 top-10 h-80 w-80 rounded-full bg-emerald-500/10 blur-[100px]" />
        <div className="relative mx-auto max-w-6xl px-4 py-20 md:py-24">
          <div className="grid gap-12 md:grid-cols-2">
            <div data-reveal>
              <SectionTitle kicker="Privacidade" title="Local por padrão. Publicar é escolha sua." align="left" />
              <p className="mt-4 text-[15px] leading-relaxed text-dim">
                O Multica é um programa que roda no seu computador (ou num servidor seu). Não existe nuvem do Multica, conta externa nem telemetria.
              </p>
              <ul className="mt-7 space-y-4 text-sm">
                <Item icon={HardDrive}>Issues, usuários e histórico ficam no <b className="text-fg">seu</b> Postgres; clones e worktrees, na pasta de dados local.</Item>
                <Item icon={Terminal}>Os agentes são o <b className="text-fg">seu</b> <code>claude</code> e o <b className="text-fg">seu</b> <code>codex</code>, com o login que você já tem.</Item>
                <Item icon={FolderGit2}>O git usa as <b className="text-fg">suas</b> credenciais (SSH, token ou gh). O código só vai para os remotos que você cadastrar.</Item>
                <Item icon={Lock}>Por padrão o servidor escuta só em <code>localhost</code>: ninguém de fora acessa.</Item>
              </ul>
            </div>
            <div data-reveal style={{ '--d': '120ms' } as React.CSSProperties} className="rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent p-6 shadow-[0_30px_60px_-30px_rgb(0_0_0/0.8)]">
              <div className="flex items-center gap-2 font-medium"><Globe className="size-4 text-accent" /> Quer acessar do celular ou chamar o time?</div>
              <p className="mt-2 text-sm text-dim">Só se você quiser. Da opção mais fechada para a mais aberta:</p>
              <div className="relative mt-5 space-y-2.5 text-sm">
                <div className="absolute bottom-4 left-[11px] top-4 w-px bg-gradient-to-b from-emerald-400/60 via-amber-400/40 to-red-400/50" />
                <Option level={0} title="VPN (Tailscale, WireGuard)" tag="recomendado">Celular e colegas entram na sua rede privada; nada fica exposto na internet.</Option>
                <Option level={1} title="Rede local">Suba com <code>MULTICA_ADDR=0.0.0.0:8700</code> e acesse pelo IP da máquina, na mesma Wi-Fi.</Option>
                <Option level={2} title="Túnel (Cloudflare Tunnel, ngrok)">Um endereço público temporário. Use com HTTPS e senhas fortes.</Option>
                <Option level={3} title="Servidor próprio">Docker Compose com proxy reverso (Caddy, nginx) e <code>MULTICA_SECURE_COOKIE=true</code>.</Option>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Começar */}
      <section id="comecar" className="scroll-mt-14">
        <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
          <SectionTitle kicker="Começar" title="Em cinco minutos" />
          <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Step n={1} title="Suba o Multica">
              <Code>{`# na pasta do projeto
./run-local.sh           # Postgres no Docker + servidor nativo
# ou, tudo em container:
docker compose up -d --build`}</Code>
              <p>Acesse <code>http://localhost:8700</code>. O primeiro cadastro vira o <b className="text-fg">dono</b>: pode tudo e define as permissões.</p>
            </Step>
            <Step n={2} title="Confira git e agentes">
              <p>Em <b className="text-fg">Servidor</b>: o Claude Code e o Codex precisam aparecer como instalados, e o git com chave SSH, credential helper ou <code>gh</code> autenticado.</p>
              <Code>{`claude          # /login, uma vez
codex login
gh auth login   # ou uma chave SSH`}</Code>
            </Step>
            <Step n={3} title="Workspace e repositórios">
              <p>Crie um workspace e adicione os repositórios git (o Multica testa o acesso ao salvar). Escreva uma <b className="text-fg">descrição</b> de uma linha em cada um: é com ela que a IA escolhe onde mexer.</p>
            </Step>
            <Step n={4} title="Agentes e skills">
              <p>Crie skills (guias e scripts), crie agentes e indexe as skills neles. Ex.: "Dev Sonnet" com as skills de padrão de código e testes; "Revisor" com a de checklist.</p>
            </Step>
            <Step n={5} title="Pessoas e perfis">
              <p>Em <b className="text-fg">Permissões</b>, monte os perfis. Em <b className="text-fg">Usuários</b>, crie as contas, escolha o perfil e os workspaces de cada pessoa.</p>
            </Step>
            <Step n={6} title="Primeira issue">
              <p>Aperte <kbd className="rounded border border-line bg-white/[0.04] px-1.5 font-mono text-[11px]">C</kbd>, descreva o que quer, escolha o agente e deixe em <b className="text-fg">A fazer</b>. Acompanhe o log, revise o diff e faça o merge.</p>
            </Step>
          </div>

          <div data-reveal className="relative mt-16 overflow-hidden rounded-3xl border border-white/[0.08] px-6 py-12 text-center">
            <div className="hero-grid pointer-events-none absolute inset-0 opacity-60" />
            <div className="blob pointer-events-none absolute -bottom-32 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-accent/25 blur-[100px]" />
            <div className="relative">
              <h2 className="text-balance text-2xl font-semibold tracking-tight md:text-4xl">Sua primeira issue está a um <span className="text-gradient">C</span> de distância.</h2>
              <p className="mx-auto mt-3 max-w-lg text-dim">Sem cadastro externo, sem cartão, sem nuvem. Só o seu computador.</p>
              <Link to={cta.to} className="btn-shine group mt-7 inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-b from-accent to-accent/80 px-6 font-medium text-white shadow-[0_10px_30px_-10px_rgb(var(--accent)/0.9)] transition hover:brightness-110">
                <Sparkles className="size-4" /> {cta.label} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-6 text-xs text-mute">
          <img src="/icon.svg" alt="" className="size-4" /> Multica · self-hosted, local por padrão
          <span className="ml-auto">Go · PostgreSQL · React</span>
        </div>
      </footer>
    </div>
  );
}

const FEATURES: [typeof Bot, string, React.ReactNode][] = [
  [FolderGit2, 'Vários repositórios por workspace', 'Front, API, mobile… A issue recebe todos e a IA decide em quais mexer, guiada pela descrição de cada um. Só os alterados ganham branch e merge.'],
  [Bot, 'Agentes como presets', 'Runtime (Claude ou Codex), modelo, esforço, teto de custo, instruções e um pacote de skills. Mesmo modelo com papéis diferentes: dev, revisor, testes.'],
  [BookOpen, 'Skills compartilhadas', 'Escreva uma vez, indexe em quantos agentes quiser. Editou a skill, todos os agentes passam a usar a versão nova.'],
  [MessageSquareText, 'Ajuste por comentário', '"Troque o botão para verde": o comentário vira um chat novo, com o agente que você escolher, levando o README da issue.'],
  [Workflow, 'Etapas e automações', 'Crie etapas e regras: ao entrar em uma etapa, notificar, chamar webhook, rodar agente, abrir PR, fazer merge ou rodar script.'],
  [Hand, 'A IA diz quando precisa de você', 'Cada execução termina como concluída, aguardando você ou incompleta. Pergunta vira comentário e você responde ali mesmo.'],
  [ShieldCheck, 'Permissões por perfil', 'O dono monta perfis (criar, editar e excluir issues, agentes, skills, repositórios…) e cada pessoa vê só os workspaces dela.'],
  [Mail, 'Aviso por e-mail', 'Issue nova avisa o workspace inteiro numa conversa só por workspace. O dono liga; quem não quiser desliga no perfil.'],
  [Wallet, 'Custo sob controle', 'Issues resolvidas e custo por mês, tokens, tempo, ranking de agentes e modelos. Teto em US$ por execução no Claude.'],
  [GitMerge, 'Merge seguro', 'Cada issue numa pasta e numa branch próprias, num sandbox que só grava ali. Vários repositórios: ou todos os merges passam, ou nada é publicado.'],
  [Laptop, 'Celular e tablet', 'Interface responsiva e instalável (PWA). Arraste cartões no toque, acompanhe o log de onde estiver.']
];

// Luz que segue o mouse nos cartões (.spot usa --x/--y).
function spot(e: React.MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`);
}

// Demonstração animada: uma issue atravessa o quadro enquanto o log do agente é escrito.
const COLS = [
  { label: 'A fazer', color: '#d4d4d8' },
  { label: 'Em andamento', color: '#f5b83d' },
  { label: 'Em revisão', color: '#4ade80' },
  { label: 'Concluída', color: '#60a5fa' }
];
const SCRIPT: [number, string, string?][] = [
  [0, 'MUL-42 na fila → Dev Sonnet', 'mute'],
  [1, 'worktrees web, api → branch mul-42'],
  [1, 'lendo skill padrao-de-codigo.md', 'mute'],
  [1, 'editando web/src/pages/Login.tsx'],
  [1, 'editando api/auth/google.go'],
  [1, 'go test ./... ok · vitest 38 passed', 'ok'],
  [2, 'resumo atualizado · 2 repos · US$ 0,41', 'ok'],
  [3, 'merge --no-ff em main · web ✓ api ✓', 'accent']
];

function FlowDemo() {
  const [tick, setTick] = useState(() => (reduced() ? SCRIPT.length - 1 : 0));
  useEffect(() => {
    if (reduced()) return;
    const id = setInterval(() => setTick((t) => (t + 1) % (SCRIPT.length + 3)), 900);
    return () => clearInterval(id);
  }, []);
  const shown = Math.min(tick, SCRIPT.length - 1);
  const step = SCRIPT[shown][0];
  const lines = SCRIPT.slice(0, shown + 1);
  const others: Record<number, [string, string][]> = {
    0: [['MUL-45', 'Exportar relatório em CSV']],
    1: [['MUL-39', 'Paginação na lista de pedidos']],
    2: [],
    3: [['MUL-37', 'Corrigir fuso no agendamento'], ['MUL-31', 'Atualizar dependências']]
  };

  return (
    <div className="relative">
      <div className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-b from-white/15 via-white/5 to-transparent" />
      <div className="relative overflow-hidden rounded-2xl bg-panel/95 text-left shadow-[0_40px_120px_-30px_rgb(var(--accent)/0.45),0_30px_60px_-30px_rgb(0_0_0/0.9)]">
        <div className="flex h-9 items-center gap-1.5 border-b border-white/[0.06] px-3.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]/80" /><span className="size-2.5 rounded-full bg-[#febc2e]/80" /><span className="size-2.5 rounded-full bg-[#28c840]/80" />
          <span className="mx-auto flex items-center gap-1.5 rounded-md bg-white/[0.04] px-3 py-0.5 text-[11px] text-mute"><Lock className="size-2.5" /> localhost:8700</span>
        </div>
        <div className="grid md:grid-cols-[1fr_300px]">
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
            {COLS.map((c, i) => (
              <div key={c.label} className={clsx('min-w-0 rounded-xl bg-white/[0.02] p-2 transition-colors duration-500', step === i && 'bg-white/[0.045]')}>
                <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-medium text-dim">
                  <span className="size-2 rounded-full" style={{ background: c.color }} />
                  <span className="truncate">{c.label}</span>
                  <span className="ml-auto text-mute">{others[i].length + (step === i ? 1 : 0)}</span>
                </div>
                <div className="space-y-1.5">
                  {step === i && (
                    <div key={i} className="demo-card rounded-lg border border-accent/40 bg-card p-2 shadow-[0_8px_24px_-10px_rgb(var(--accent)/0.7)]">
                      <div className="flex items-center gap-1.5 text-[10px] text-mute">
                        MUL-42
                        {i === 1 && <span className="ml-auto size-1.5 animate-pulse-soft rounded-full bg-amber-400" />}
                        {i === 3 && <CheckCircle2 className="ml-auto size-3 text-sky-400" />}
                      </div>
                      <div className="mt-0.5 truncate text-[12px] font-medium">Login com Google</div>
                      <div className="mt-1.5 flex items-center gap-1">
                        <span className="grid size-3.5 place-items-center rounded bg-accent/25"><Bot className="size-2.5 text-accent" /></span>
                        <span className="truncate text-[10px] text-dim">Dev Sonnet</span>
                      </div>
                    </div>
                  )}
                  {others[i].map(([k, t]) => (
                    <div key={k} className="rounded-lg border border-white/[0.05] bg-card/60 p-2">
                      <div className="text-[10px] text-mute">{k}</div>
                      <div className="mt-0.5 truncate text-[12px] text-dim">{t}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-[1.7] md:border-l md:border-t-0">
            <div className="mb-1.5 flex items-center gap-1.5 font-sans text-[11px] text-mute"><Terminal className="size-3" /> Log do agente</div>
            <div className="h-[168px] overflow-hidden">
              {lines.map(([, text, tone], i) => (
                <div key={i} className={clsx('demo-line truncate', tone === 'ok' ? 'text-emerald-400' : tone === 'accent' ? 'text-accent' : tone === 'mute' ? 'text-mute' : 'text-dim')}>
                  <span className="text-mute/60">› </span>{text}
                </div>
              ))}
              {tick < SCRIPT.length - 1 && <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse-soft bg-accent/80" />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Marquee() {
  const items = ['Claude Code', 'Codex', 'git worktree', 'PostgreSQL', 'Go', 'React', 'Docker', 'Tailscale', 'SSH', 'gh CLI', 'PWA', 'SMTP'];
  return (
    <div className="marquee relative border-y border-white/[0.06] py-4 text-sm text-mute">
      <div className="marquee-track flex w-max gap-10">
        {[...items, ...items].map((t, i) => (
          <span key={i} className="flex items-center gap-10 whitespace-nowrap">{t}<span className="size-1 rounded-full bg-white/15" /></span>
        ))}
      </div>
    </div>
  );
}

// Abas com as capturas reais; avança sozinha e pausa com o mouse em cima.
const SHOTS = [
  { icon: LayoutGrid, label: 'Quadro', src: '/shots/board.jpg', text: 'Arraste entre colunas; o que está rodando pulsa.' },
  { icon: Terminal, label: 'Issue', src: '/shots/issue.jpg', text: 'Log ao vivo, resumo, diff por repositório e merge.' },
  { icon: Bot, label: 'Agentes', src: '/shots/agents.jpg', text: 'Presets de modelo, esforço, custo e skills.' },
  { icon: ShieldCheck, label: 'Permissões', src: '/shots/permissions.jpg', text: 'Perfis com o que cada pessoa pode fazer.' },
  { icon: BarChart3, label: 'Analytics', src: '/shots/analytics.jpg', text: 'Issues resolvidas e custo por mês, rankings.' }
];

function Gallery() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || reduced()) return;
    const id = setTimeout(() => setI((n) => (n + 1) % SHOTS.length), 5000);
    return () => clearTimeout(id);
  }, [i, paused]);

  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="mx-auto flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
        {SHOTS.map((s, n) => (
          <button
            key={s.label}
            onClick={() => setI(n)}
            className={clsx('relative flex shrink-0 items-center gap-1.5 overflow-hidden rounded-lg px-3 py-1.5 text-sm transition-colors', n === i ? 'bg-white/[0.08] text-fg' : 'text-dim hover:text-fg')}
          >
            <s.icon className="size-3.5" /> {s.label}
            {n === i && !paused && <span key={i} className="tab-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent/70" />}
          </button>
        ))}
      </div>
      <p className="mt-3 h-5 text-center text-sm text-dim">{SHOTS[i].text}</p>
      <div className="relative mx-auto mt-6 max-w-5xl">
        <div className="pointer-events-none absolute -inset-x-10 -bottom-10 top-10 rounded-full bg-accent/15 blur-[90px]" />
        <div className="relative grid">
          {SHOTS.map((s, n) => (
            <div key={s.src} className={clsx('[grid-area:1/1] transition-all duration-700', n === i ? 'opacity-100' : 'pointer-events-none scale-[0.985] opacity-0')} aria-hidden={n !== i}>
              <Shot src={s.src} alt={s.label} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ kicker, title, align = 'center' }: { kicker: string; title: string; align?: 'center' | 'left' }) {
  return (
    <div data-reveal className={align === 'center' ? 'text-center' : ''}>
      <div className={clsx('inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-accent', align === 'center' && 'justify-center')}>
        <span className="h-px w-5 bg-gradient-to-r from-transparent to-accent" />{kicker}<span className="h-px w-5 bg-gradient-to-l from-transparent to-accent" />
      </div>
      <h2 className="mt-3 text-balance text-[1.7rem] font-semibold tracking-[-0.025em] md:text-4xl">{title}</h2>
    </div>
  );
}

function Feature({ icon: Icon, title, delay, children }: { icon: typeof Bot; title: string; delay: number; children: React.ReactNode }) {
  return (
    <div data-reveal style={{ '--d': `${delay}ms` } as React.CSSProperties} onMouseMove={spot}
      className="spot group relative rounded-2xl border border-white/[0.07] bg-panel/80 p-5 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-white/[0.14]">
      <span className="grid size-9 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-accent transition-colors group-hover:border-accent/40 group-hover:bg-accent/10">
        <Icon className="size-[18px]" />
      </span>
      <h3 className="mt-4 font-medium">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-dim">{children}</p>
    </div>
  );
}

function Item({ icon: Icon, children }: { icon: typeof Bot; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-dim">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-emerald-400/20 bg-emerald-400/[0.07]"><Icon className="size-3.5 text-emerald-400" /></span>
      <span className="pt-1 leading-relaxed">{children}</span>
    </li>
  );
}

function Option({ title, tag, level, children }: { title: string; tag?: string; level: number; children: React.ReactNode }) {
  const dot = ['bg-emerald-400', 'bg-lime-400', 'bg-amber-400', 'bg-orange-400'][level];
  return (
    <div className="relative flex gap-3">
      <span className="relative z-10 mt-3.5 grid size-[23px] shrink-0 place-items-center rounded-full border border-white/10 bg-panel"><span className={clsx('size-2 rounded-full', dot)} /></span>
      <div className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 transition-colors hover:border-white/[0.14]">
        <div className="flex flex-wrap items-center gap-2 font-medium">{title}{tag && <span className="rounded-full bg-emerald-400/15 px-2 py-px text-[10px] font-medium text-emerald-300">{tag}</span>}</div>
        <p className="mt-0.5 text-dim">{children}</p>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div data-reveal style={{ '--d': `${(n % 2 ? 0 : 1) * 90}ms` } as React.CSSProperties} onMouseMove={spot}
      className="spot relative min-w-0 rounded-2xl border border-white/[0.07] bg-panel/80 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-b from-accent to-accent/70 font-mono text-xs font-semibold text-white shadow-[0_4px_14px_-4px_rgb(var(--accent)/0.8)]">{n}</span>
        <h3 className="font-medium">{title}</h3>
      </div>
      <div className="mt-3 space-y-2.5 text-sm leading-relaxed text-dim">{children}</div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(children.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.replace(/\s+#.*$/, '')).join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-xl border border-white/[0.07] bg-black/40 p-3.5 pr-10 font-mono text-[12px] leading-relaxed text-fg">
        {children.split('\n').map((l, i) => {
          const at = l.indexOf('#');
          return <div key={i}>{at < 0 ? l : <>{l.slice(0, at)}<span className="text-mute">{l.slice(at)}</span></>}</div>;
        })}
      </pre>
      <button onClick={copy} aria-label="Copiar" className="absolute right-2 top-2 grid size-7 place-items-center rounded-md border border-white/[0.08] bg-panel text-mute opacity-0 transition hover:text-fg group-hover:opacity-100 max-md:opacity-100">
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

// Captura de tela com moldura de janela; some se a imagem não existir.
function Shot({ src, alt, className = '', tilt }: { src: string; alt: string; className?: string; tilt?: boolean }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <div className={clsx('overflow-hidden rounded-xl border border-white/[0.08] bg-panel shadow-[0_30px_80px_-30px_rgb(0_0_0/0.9)]', tilt && 'tilt', className)}>
      <div className="flex h-7 items-center gap-1.5 border-b border-white/[0.06] px-3">
        <span className="size-2.5 rounded-full bg-[#ff5f57]/70" /><span className="size-2.5 rounded-full bg-[#febc2e]/70" /><span className="size-2.5 rounded-full bg-[#28c840]/70" />
      </div>
      <img src={src} alt={alt} loading="lazy" onError={() => setOk(false)} className="block w-full" />
    </div>
  );
}
