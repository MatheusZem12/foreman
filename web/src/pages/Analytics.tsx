import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { Activity, AlertTriangle, BarChart3, Bot, CheckCircle2, Clock, Coins, Cpu, Sparkles, Table2, Users, Zap } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, EmptyState, PageHeader, PriorityIcon, Spinner, StatusIcon } from '../components/ui';
import { api } from '../lib/api';
import { PRIORITIES, STATUSES, statusOf } from '../lib/constants';
import { compact, duration, money } from '../lib/format';
import { useAgents } from '../lib/queries';
import type { Agent, Analytics, Totals } from '../lib/types';
import { AgentIcon } from '../components/AgentIcon';

// Paleta categórica validada (daltonismo + contraste) para a superfície escura.
const C1 = 'var(--chart-1)';
const C3 = 'var(--chart-3)';
const AXIS = { fontSize: 11, fill: 'rgb(var(--mute))' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] + '/' + m.slice(2, 4);
const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

type Metric = 'cost' | 'tokens' | 'runs' | 'time';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: 'Custo' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'runs', label: 'Execuções' },
  { id: 'time', label: 'Tempo' }
];
const metricOf = (t: Totals | undefined, m: Metric) =>
  !t ? 0 : m === 'cost' ? t.costUsd : m === 'tokens' ? t.inputTokens + t.cachedTokens + t.outputTokens : m === 'runs' ? t.runs : t.seconds;
const fmtMetric = (v: number, m: Metric) => (m === 'cost' ? money(v) : m === 'time' ? duration(v) : compact(v));
const hours = (h: number) => (!h ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} dias`);

function Segmented<T extends string>({ items, value, onChange }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg border border-line bg-white/[0.02] p-0.5">
      {items.map((i) => (
        <button key={i.id} onClick={() => onChange(i.id)}
          className={clsx('rounded-md px-2.5 py-1 text-xs transition', value === i.id ? 'bg-white/10 text-fg shadow-sm' : 'text-mute hover:text-fg')}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

function Card({ title, subtitle, actions, children, className }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx('surface flex flex-col p-4', className)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{title}</h2>
          {subtitle && <p className="text-xs text-mute">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

// Tooltip escuro comum a todos os gráficos.
function Tip({ active, payload, label, format, labelFormat }: {
  active?: boolean; payload?: { name: string; value: number; color?: string; payload?: { color?: string } }[]; label?: string;
  format?: (v: number) => string; labelFormat?: (l: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-panel/95 px-3 py-2 text-xs shadow-pop backdrop-blur">
      {label && <div className="mb-1 text-mute">{labelFormat ? labelFormat(label) : label}</div>}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.payload?.color ?? p.color }} />
          <span className="text-dim">{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums text-fg">{format ? format(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, spark, color = C1, className }: {
  icon: typeof Coins; label: string; value: string; sub?: React.ReactNode; spark?: number[]; color?: string; className?: string;
}) {
  const id = `sp-${label.replace(/\W/g, '')}`;
  return (
    <div className={clsx('surface relative overflow-hidden p-4', className)}>
      <div className="flex items-center gap-2 text-xs text-mute"><Icon className="size-3.5" /> {label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="relative z-10 mt-0.5 text-xs text-mute">{sub}</div>}
      {spark && spark.some(Boolean) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 opacity-60">
          <ResponsiveContainer>
            <AreaChart data={spark.map((v, i) => ({ i, v }))} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#${id})`} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Linha de ranking com barra (agentes, modelos, pessoas).
function RankRow({ left, value, share, sub }: { left: React.ReactNode; value: string; share: number; sub?: string }) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
        <span className="font-medium tabular-nums">{value}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
          <div className="h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: C1 }} />
        </div>
        {sub && <span className="w-28 shrink-0 text-right text-[11px] text-mute">{sub}</span>}
      </div>
    </div>
  );
}

type Day = { day: string; value: number; cost: number; runs: number; t?: Totals };

export function AnalyticsPage() {
  const { ws } = useWs();
  const [days, setDays] = useState<'7' | '30' | '90' | '365'>('30');
  const [scope, setScope] = useState<'ws' | 'all'>('ws');
  const [metric, setMetric] = useState<Metric>('cost');
  const [table, setTable] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('mx.analyticsTab') as Tab) || 'geral';
    } catch {
      return 'geral';
    }
  });
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem('mx.analyticsTab', t);
    } catch {
      /* sem storage */
    }
  };
  const { data: agents = [] } = useAgents();
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', scope === 'ws' ? ws.id : '', days],
    queryFn: () => api.get<Analytics>(`/analytics?days=${days}&workspace=${scope === 'ws' ? ws.id : ''}`)
  });

  // Dias sem execução entram com zero: o eixo do tempo fica contínuo.
  const daily = useMemo<Day[]>(() => {
    if (!data) return [];
    const by = new Map(data.daily.map((d) => [d.day, d]));
    return Array.from({ length: Number(days) }, (_, k) => {
      const d = new Date();
      d.setDate(d.getDate() - (Number(days) - 1 - k));
      const key = d.toISOString().slice(0, 10);
      const t = by.get(key);
      return { day: key, value: metricOf(t, metric), cost: t?.costUsd ?? 0, runs: t?.runs ?? 0, t };
    });
  }, [data, days, metric]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl p-4 pb-24 md:p-8">
        <PageHeader
          icon={BarChart3}
          title="Analytics"
          description="Custo, volume e ritmo das issues e dos agentes."
          actions={
            <div className="flex flex-wrap gap-2">
              <Segmented items={[{ id: 'ws', label: ws.name }, { id: 'all', label: 'Todos' }]} value={scope} onChange={setScope} />
              <Segmented items={[{ id: '7', label: '7d' }, { id: '30', label: '30d' }, { id: '90', label: '90d' }, { id: '365', label: '1 ano' }]} value={days} onChange={setDays} />
            </div>
          }
        />
        <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
          {TABS.map((x) => (
            <button key={x.id} onClick={() => pick(x.id)} title={x.hint}
              className={clsx('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors', tab === x.id ? 'border-accent font-medium text-fg' : 'border-transparent text-mute hover:text-fg')}>
              <x.icon className="size-3.5" /> {x.label}
            </button>
          ))}
        </div>
        {isLoading || !data
          ? <div className="grid h-64 place-items-center"><Spinner /></div>
          : <Dashboards tab={tab} data={data} daily={daily} days={days} metric={metric} setMetric={setMetric} table={table} setTable={setTable} agents={agents} wsKey={ws.key} />}
      </div>
    </div>
  );
}

function Dashboards({ tab, data, daily, days, metric, setMetric, table, setTable, agents, wsKey }: {
  tab: Tab; data: Analytics; daily: Day[]; days: string; metric: Metric; setMetric: (m: Metric) => void;
  table: boolean; setTable: (b: boolean) => void; agents: Agent[]; wsKey: string;
}) {
  const t = data.totals;
  const tokens = t.inputTokens + t.cachedTokens + t.outputTokens;
  const success = t.runs ? Math.round(((t.runs - t.failed) / t.runs) * 100) : 0;
  const cacheShare = tokens ? Math.round((t.cachedTokens / tokens) * 100) : 0;
  const monthly = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const status = STATUSES.map((s) => ({ ...s, value: data.status.find((x) => x.status === s.id)?.count ?? 0 })).filter((s) => s.value > 0);
  const statusTotal = status.reduce((a, s) => a + s.value, 0);
  const maxAgent = Math.max(...data.agents.map((a) => a.costUsd), 1e-6);
  const maxModel = Math.max(...data.models.map((a) => a.costUsd), 1e-6);
  const maxUser = Math.max(...data.users.map((u) => u.runs), 1);

  if (!t.runs && !data.issues.created && !data.issues.open) {
    return (
      <EmptyState icon={Sparkles} title="Ainda não há dados" action={<Link to={`/w/${wsKey}`} className="text-sm text-accent hover:underline">Ir para o quadro</Link>}>
        Crie issues e rode os agentes: custo, issues resolvidas por mês e o ranking de agentes e modelos aparecem aqui.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      {tab === 'geral' && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi icon={Coins} label={`Custo · ${days}d`} value={money(t.costUsd)} sub={`${money(t.runs ? t.costUsd / t.runs : 0)} por execução`} spark={daily.map((d) => d.cost)} />
        <Kpi icon={CheckCircle2} label="Issues resolvidas" value={String(data.issues.resolved)} sub={`${data.issues.created} criadas · ${data.issues.open} abertas`} />
        <Kpi icon={Activity} label="Execuções" value={compact(t.runs)} sub={<><span className={success >= 80 ? 'text-emerald-400' : 'text-amber-400'}>{success}%</span> com sucesso</>} spark={daily.map((d) => d.runs)} color={C3} />
        <Kpi icon={Clock} label="Tempo até resolver" value={hours(data.issues.avgResolveHours)} sub={`mediana ${hours(data.issues.medResolveHours)} · agentes ${duration(t.seconds)}`} />
        <Kpi icon={Zap} label="Tokens" value={compact(tokens)} sub={`${cacheShare}% vieram do cache`} className="col-span-2 lg:col-span-1" />
      </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Issues por mês" subtitle="Criadas × resolvidas, últimos 12 meses" className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={monthly} barGap={2} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgb(255 255 255 / 0.04)' }} content={<Tip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'rgb(var(--dim))' }} />
                <Bar animationDuration={500} dataKey="created" name="Criadas" fill={C1} radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar animationDuration={500} dataKey="resolved" name="Resolvidas" fill={C3} radius={[4, 4, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Status" subtitle="Abertas agora + encerradas no período">
          {statusTotal ? (
            <div className="flex h-64 flex-col">
              <div className="relative min-h-0 flex-1">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie animationDuration={500} data={status} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="90%" paddingAngle={2} stroke="rgb(var(--panel))" strokeWidth={2}>
                      {status.map((s) => <Cell key={s.id} fill={s.color} />)}
                    </Pie>
                    <Tooltip content={<Tip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                  <div><div className="text-2xl font-semibold tabular-nums">{statusTotal}</div><div className="text-[11px] text-mute">issues</div></div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {status.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5"><StatusIcon status={s.id} /><span className="text-dim">{s.label}</span><span className="ml-auto tabular-nums">{s.value}</span></div>
                ))}
              </div>
            </div>
          ) : <p className="py-16 text-center text-mute">Sem issues.</p>}
        </Card>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Atividade diária"
          subtitle={`Últimos ${days} dias`}
          className="lg:col-span-3"
          actions={
            <div className="flex gap-2">
              <Segmented items={METRICS} value={metric} onChange={setMetric} />
              <button onClick={() => setTable(!table)} title="Ver como tabela" className={clsx('rounded-lg border border-line p-1.5', table ? 'bg-white/10 text-fg' : 'text-mute hover:text-fg')}><Table2 className="size-3.5" /></button>
            </div>
          }
        >
          {table ? (
            <div className="max-h-56 overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-panel text-left text-mute"><tr><th className="py-1.5 font-medium">Dia</th><th className="font-medium">Execuções</th><th className="font-medium">Custo</th><th className="font-medium">Tokens</th><th className="font-medium">Tempo</th></tr></thead>
                <tbody>
                  {[...daily].reverse().filter((d) => d.t).map((d) => (
                    <tr key={d.day} className="border-t border-line/60 tabular-nums">
                      <td className="py-1.5">{dayLabel(d.day)}</td><td>{d.runs}</td><td>{money(d.cost)}</td><td>{compact(metricOf(d.t, 'tokens'))}</td><td>{duration(d.t!.seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!daily.some((d) => d.t) && <p className="py-8 text-center text-mute">Nenhuma execução no período.</p>}
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer>
                <AreaChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C1} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={C1} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="day" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={dayLabel} minTickGap={24} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => fmtMetric(v, metric)} />
                  <Tooltip cursor={{ stroke: 'rgb(255 255 255 / 0.15)' }} content={<Tip format={(v) => fmtMetric(v, metric)} labelFormat={dayLabel} />} />
                  <Area animationDuration={500} dataKey="value" name={METRICS.find((m) => m.id === metric)!.label} stroke={C1} strokeWidth={2} fill="url(#area)" activeDot={{ r: 4, strokeWidth: 2, stroke: 'rgb(var(--panel))' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        </div>
      </>}

      {tab === 'tempo' && <TimeTab data={data} />}

      {tab === 'custos' && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={Coins} label={`Custo · ${days}d`} value={money(t.costUsd)} sub={`${money(t.runs ? t.costUsd / t.runs : 0)} por execução`} spark={daily.map((d) => d.cost)} />
          <Kpi icon={CheckCircle2} label="Custo por issue resolvida" value={money(data.issues.resolved ? t.costUsd / data.issues.resolved : 0)} sub={`${data.issues.resolved} resolvidas`} />
          <Kpi icon={Zap} label="Tokens" value={compact(tokens)} sub={`${cacheShare}% vieram do cache`} />
          <Kpi icon={Cpu} label="Modelos usados" value={String(data.models.length)} sub={`${data.agents.length} agente(s)`} />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Custo por mês" subtitle="Últimos 12 meses" className="lg:col-span-2">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={monthly} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => money(v)} />
                <Tooltip cursor={{ fill: 'rgb(255 255 255 / 0.04)' }} content={<Tip format={money} />} />
                <Bar animationDuration={500} dataKey="costUsd" name="Custo" fill={C1} radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
          <CostByPriority data={data} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <CostByCreator data={data} />
        <Card title="Modelos" subtitle="Custo e tokens por modelo">
          {data.models.length ? data.models.map((m) => (
            <RankRow key={m.runtime + m.model} share={m.costUsd / maxModel} value={money(m.costUsd)}
              sub={`${compact(m.inputTokens + m.cachedTokens + m.outputTokens)} tokens`}
              left={<><Cpu className="size-4 shrink-0 text-mute" /><span className="truncate">{m.model || 'padrão'}</span><span className="rounded bg-white/5 px-1.5 text-[10px] text-mute">{m.runtime === 'codex' ? 'Codex' : 'Claude'}</span></>} />
          )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
        </Card>
        </div>
        <Card title="Issues mais caras" subtitle="No período">
          {data.top.length ? (
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="text-xs text-mute"><tr><th className="px-4 py-2 font-medium">Issue</th><th className="px-4 font-medium">Status</th><th className="px-4 text-right font-medium">Execuções</th><th className="px-4 text-right font-medium">Custo</th></tr></thead>
                <tbody>
                  {data.top.map((i) => (
                    <tr key={i.id} className="border-t border-line/60 transition-colors hover:bg-white/[0.03]">
                      <td className="max-w-0 px-4 py-2.5"><Link to={`/w/${i.ref.split('-')[0]}/issues/${i.ref}`} className="flex min-w-0 items-center gap-2 hover:text-accent"><span className="shrink-0 font-mono text-xs text-mute">{i.ref}</span><span className="truncate">{i.title}</span></Link></td>
                      <td className="whitespace-nowrap px-4"><span className="inline-flex items-center gap-1.5 text-xs text-dim"><StatusIcon status={i.status} />{statusOf(i.status).label}</span></td>
                      <td className="px-4 text-right tabular-nums">{i.runs}</td>
                      <td className="px-4 text-right font-medium tabular-nums">{money(i.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="py-8 text-center text-mute">Nenhuma execução no período.</p>}
        </Card>
      </>}

      {tab === 'pessoas' && <>
        <PeopleTab data={data} />
        <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Quem mais pede" subtitle="Execuções disparadas por pessoa">
          {data.users.length ? data.users.map((u) => (
            <RankRow key={u.userId ?? 'sys'} share={u.runs / maxUser} value={String(u.runs)} sub={money(u.costUsd)}
              left={<><Avatar name={u.name} size={20} /><span className="truncate">{u.name}</span></>} />
          )) : <p className="py-10 text-center text-mute"><Users className="mx-auto mb-2 size-5" />Ninguém ainda.</p>}
        </Card>
          <CostByCreator data={data} />
        </div>
      </>}

      {tab === 'agentes' && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={Activity} label="Execuções" value={compact(t.runs)} sub={<><span className={success >= 80 ? 'text-emerald-400' : 'text-amber-400'}>{success}%</span> com sucesso</>} spark={daily.map((d) => d.runs)} color={C3} />
          <Kpi icon={Clock} label="Tempo médio por execução" value={duration(t.runs ? t.seconds / t.runs : 0)} sub={`${duration(t.seconds)} no total`} />
          <Kpi icon={Coins} label="Custo por execução" value={money(t.runs ? t.costUsd / t.runs : 0)} sub={`${t.failed} falha(s)`} />
          <Kpi icon={Zap} label="Tokens por execução" value={compact(t.runs ? tokens / t.runs : 0)} sub={`${cacheShare}% do cache`} />
        </div>
        <AgentTable data={data} agents={agents} />
        <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Agentes" subtitle="Custo no período">
          {data.agents.length ? data.agents.map((a) => (
            <RankRow key={a.agentId ?? a.agentName} share={a.costUsd / maxAgent} value={money(a.costUsd)}
              sub={`${a.runs} exec. · ${a.runs ? Math.round(((a.runs - a.failed) / a.runs) * 100) : 0}% ok`}
              left={<><AgentIcon avatar={agents.find((x) => x.id === a.agentId)?.avatar} size={20} /><span className="truncate">{a.agentName || 'Removido'}</span></>} />
          )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
        </Card>
        <Card title="Modelos" subtitle="Custo e tokens por modelo">
          {data.models.length ? data.models.map((m) => (
            <RankRow key={m.runtime + m.model} share={m.costUsd / maxModel} value={money(m.costUsd)}
              sub={`${compact(m.inputTokens + m.cachedTokens + m.outputTokens)} tokens`}
              left={<><Cpu className="size-4 shrink-0 text-mute" /><span className="truncate">{m.model || 'padrão'}</span><span className="rounded bg-white/5 px-1.5 text-[10px] text-mute">{m.runtime === 'codex' ? 'Codex' : 'Claude'}</span></>} />
          )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
        </Card>
        </div>
      </>}
    </div>
  );
}

// ---------- abas focadas ----------

type Tab = 'geral' | 'tempo' | 'custos' | 'pessoas' | 'agentes';
const TABS: { id: Tab; label: string; icon: typeof Clock; hint: string }[] = [
  { id: 'geral', label: 'Visão geral', icon: BarChart3, hint: 'Volume, status e atividade' },
  { id: 'tempo', label: 'Tempo', icon: Clock, hint: 'Ciclo, etapas e gargalos' },
  { id: 'custos', label: 'Custos', icon: Coins, hint: 'Onde o dinheiro vai' },
  { id: 'pessoas', label: 'Pessoas', icon: Users, hint: 'Desempenho de cada um' },
  { id: 'agentes', label: 'Agentes', icon: Bot, hint: 'Eficiência dos agentes e modelos' }
];

function TimeTab({ data }: { data: Analytics }) {
  const st = data.stageTimes ?? [];
  const maxSt = Math.max(...st.map((s) => s.avgHours), 0.0001);
  const slowest = st.reduce<typeof st[number] | null>((a, b) => (!a || b.avgHours > a.avgHours ? b : a), null);
  const pr = [...(data.priorities ?? [])].sort((a, b) => a.priority - b.priority);
  const maxPr = Math.max(...pr.map((p) => p.avgSeconds), 0.0001);
  const people = (data.people ?? []).filter((p) => p.replyHours > 0).sort((a, b) => b.replyHours - a.replyHours);
  const maxReply = Math.max(...people.map((p) => p.replyHours), 0.0001);
  const t = data.totals;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Clock} label="Criação → conclusão" value={hours(data.issues.avgResolveHours)} sub={`mediana ${hours(data.issues.medResolveHours)}`} />
        <Kpi icon={CheckCircle2} label="Resolvidas no período" value={String(data.issues.resolved)} sub={`${data.issues.open} abertas agora`} />
        <Kpi icon={AlertTriangle} label="Gargalo" value={slowest ? slowest.name : '—'} sub={slowest ? `${hours(slowest.avgHours)} em média` : 'sem dados ainda'} />
        <Kpi icon={Bot} label="Tempo de agente" value={duration(t.seconds)} sub={`${duration(t.runs ? t.seconds / t.runs : 0)} por execução`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Tempo por etapa" subtitle="Média de permanência em cada etapa (mediana ao lado)" className="lg:col-span-2">
          {st.length ? st.map((s) => (
            <RankRow key={s.stage} share={s.avgHours / maxSt} value={hours(s.avgHours)} sub={`mediana ${hours(s.medHours)} · ${s.passes}×`}
              left={<><StatusIcon status={s.stage} /><span className="truncate">{s.name}</span></>} />
          )) : <p className="py-10 text-center text-mute">Ainda sem passagens completas por etapas.</p>}
        </Card>
        <Card title="Tempo de agente por prioridade" subtitle="Duração média de cada execução">
          {pr.length ? pr.map((p) => (
            <RankRow key={p.priority} share={p.avgSeconds / maxPr} value={duration(p.avgSeconds)} sub={`${p.runs} exec.`}
              left={<><PriorityIcon priority={p.priority} /><span className="truncate">{PRIORITIES.find((x) => x.id === p.priority)?.label}</span></>} />
          )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
        </Card>
      </div>
      <Card title="Tempo de resposta" subtitle="Quanto as issues de cada pessoa ficam em “Aguardando você” até alguém responder">
        {people.length ? people.map((p) => (
          <RankRow key={p.userId} share={p.replyHours / maxReply} value={hours(p.replyHours)}
            left={<><Avatar name={p.name} size={20} /><span className="truncate">{p.name}</span></>} />
        )) : <p className="py-8 text-center text-mute">Ninguém precisou responder à IA no período.</p>}
      </Card>
    </>
  );
}

function CostByPriority({ data }: { data: Analytics }) {
  const pr = [...(data.priorities ?? [])].sort((a, b) => b.costUsd - a.costUsd);
  const max = Math.max(...pr.map((p) => p.costUsd), 0.0001);
  return (
    <Card title="Custo por prioridade" subtitle="Quanto cada urgência consome">
      {pr.length ? pr.map((p) => (
        <RankRow key={p.priority} share={p.costUsd / max} value={money(p.costUsd)} sub={`${p.issues} issue(s) · ${money(p.issues ? p.costUsd / p.issues : 0)}/issue`}
          left={<><PriorityIcon priority={p.priority} /><span className="truncate">{PRIORITIES.find((x) => x.id === p.priority)?.label ?? '—'}</span></>} />
      )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
    </Card>
  );
}

function CostByCreator({ data }: { data: Analytics }) {
  const cr = data.creators ?? [];
  const max = Math.max(...cr.map((c) => c.costUsd), 0.0001);
  return (
    <Card title="Custo por quem criou" subtitle="Issues de cada pessoa, somando todas as execuções">
      {cr.length ? cr.map((c) => (
        <RankRow key={c.userId ?? 'ext'} share={c.costUsd / max} value={money(c.costUsd)} sub={`${c.runs} exec.`}
          left={<><Avatar name={c.name} size={20} /><span className="truncate">{c.name}</span></>} />
      )) : <p className="py-10 text-center text-mute">Ninguém ainda.</p>}
    </Card>
  );
}

type SortKey = 'created' | 'resolved' | 'openAssigned' | 'resolveHours' | 'replyHours' | 'comments' | 'approvals' | 'runs' | 'costUsd';

// Uma linha por pessoa: o que criou, resolveu, quanto demora e quanto custa.
function PeopleTab({ data }: { data: Analytics }) {
  const [sort, setSort] = useState<SortKey>('resolved');
  const people = [...(data.people ?? [])].sort((a, b) => (b[sort] as number) - (a[sort] as number));
  const cols: [SortKey, string, (p: Analytics['people'][number]) => string][] = [
    ['created', 'Criou', (p) => String(p.created)],
    ['openAssigned', 'Abertas c/ ela', (p) => String(p.openAssigned)],
    ['resolved', 'Resolveu', (p) => String(p.resolved)],
    ['resolveHours', 'Tempo p/ resolver', (p) => hours(p.resolveHours)],
    ['replyHours', 'Tempo de resposta', (p) => hours(p.replyHours)],
    ['comments', 'Comentários', (p) => String(p.comments)],
    ['approvals', 'Aprovações', (p) => String(p.approvals)],
    ['runs', 'Pedidos ao agente', (p) => String(p.runs)],
    ['costUsd', 'Custo', (p) => money(p.costUsd)]
  ];
  return (
    <Card title="Desempenho por pessoa" subtitle="No período · clique numa coluna para ordenar · “resolveu” conta as issues em que a pessoa é a responsável">
      {people.length ? (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-mute">
              <tr>
                <th className="px-4 py-2 font-medium">Pessoa</th>
                {cols.map(([k, label]) => (
                  <th key={k} className="whitespace-nowrap px-3 text-right font-medium">
                    <button onClick={() => setSort(k)} className={clsx('hover:text-fg', sort === k && 'text-accent')}>{label}{sort === k && ' ↓'}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className="border-t border-line/60 hover:bg-white/[0.03]">
                  <td className="whitespace-nowrap px-4 py-2.5"><span className="inline-flex items-center gap-2"><Avatar name={p.name} size={20} /> {p.name}</span></td>
                  {cols.map(([k, , f]) => <td key={k} className={clsx('px-3 text-right tabular-nums', sort === k ? 'font-medium text-fg' : 'text-dim')}>{f(p)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="py-10 text-center text-mute"><Users className="mx-auto mb-2 size-5" />Ninguém teve atividade no período.</p>}
    </Card>
  );
}

// Eficiência de cada agente: sucesso, tempo e custo por execução.
function AgentTable({ data, agents }: { data: Analytics; agents: Agent[] }) {
  return (
    <Card title="Eficiência por agente" subtitle="No período">
      {data.agents.length ? (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-mute">
              <tr>{['Agente', 'Execuções', 'Sucesso', 'Tempo médio', 'Custo/execução', 'Tokens/execução', 'Custo total'].map((h, i) => <th key={h} className={clsx('whitespace-nowrap py-2 font-medium', i ? 'px-3 text-right' : 'px-4')}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.agents.map((a) => {
                const ok = a.runs ? Math.round(((a.runs - a.failed) / a.runs) * 100) : 0;
                return (
                  <tr key={a.agentId ?? a.agentName} className="border-t border-line/60 hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-4 py-2.5"><span className="inline-flex items-center gap-2"><AgentIcon avatar={agents.find((x) => x.id === a.agentId)?.avatar} size={20} /> {a.agentName || 'Removido'}</span></td>
                    <td className="px-3 text-right tabular-nums">{a.runs}</td>
                    <td className={clsx('px-3 text-right tabular-nums', ok >= 80 ? 'text-emerald-400' : 'text-amber-400')}>{ok}%</td>
                    <td className="px-3 text-right tabular-nums">{duration(a.runs ? a.seconds / a.runs : 0)}</td>
                    <td className="px-3 text-right tabular-nums">{money(a.runs ? a.costUsd / a.runs : 0)}</td>
                    <td className="px-3 text-right tabular-nums">{compact(a.runs ? (a.inputTokens + a.cachedTokens + a.outputTokens) / a.runs : 0)}</td>
                    <td className="px-3 text-right font-medium tabular-nums">{money(a.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
    </Card>
  );
}
