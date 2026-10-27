import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { Activity, BarChart3, CheckCircle2, Clock, Coins, Cpu, Sparkles, Table2, Users, Zap } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, EmptyState, PageHeader, Spinner, StatusIcon } from '../components/ui';
import { api } from '../lib/api';
import { STATUSES, statusOf } from '../lib/constants';
import { compact, duration, money } from '../lib/format';
import { useAgents } from '../lib/queries';
import type { Agent, Analytics, Totals } from '../lib/types';

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
        {isLoading || !data
          ? <div className="grid h-64 place-items-center"><Spinner /></div>
          : <Dashboards data={data} daily={daily} days={days} metric={metric} setMetric={setMetric} table={table} setTable={setTable} agents={agents} wsKey={ws.key} />}
      </div>
    </div>
  );
}

function Dashboards({ data, daily, days, metric, setMetric, table, setTable, agents, wsKey }: {
  data: Analytics; daily: Day[]; days: string; metric: Metric; setMetric: (m: Metric) => void;
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi icon={Coins} label={`Custo · ${days}d`} value={money(t.costUsd)} sub={`${money(t.runs ? t.costUsd / t.runs : 0)} por execução`} spark={daily.map((d) => d.cost)} />
        <Kpi icon={CheckCircle2} label="Issues resolvidas" value={String(data.issues.resolved)} sub={`${data.issues.created} criadas · ${data.issues.open} abertas`} />
        <Kpi icon={Activity} label="Execuções" value={compact(t.runs)} sub={<><span className={success >= 80 ? 'text-emerald-400' : 'text-amber-400'}>{success}%</span> com sucesso</>} spark={daily.map((d) => d.runs)} color={C3} />
        <Kpi icon={Clock} label="Tempo até resolver" value={hours(data.issues.avgResolveHours)} sub={`agentes rodaram ${duration(t.seconds)}`} />
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
        <Card title="Custo por mês" subtitle="Últimos 12 meses">
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
        <Card
          title="Atividade diária"
          subtitle={`Últimos ${days} dias`}
          className="lg:col-span-2"
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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Agentes" subtitle="Custo no período">
          {data.agents.length ? data.agents.map((a) => (
            <RankRow key={a.agentId ?? a.agentName} share={a.costUsd / maxAgent} value={money(a.costUsd)}
              sub={`${a.runs} exec. · ${a.runs ? Math.round(((a.runs - a.failed) / a.runs) * 100) : 0}% ok`}
              left={<><Avatar emoji={agents.find((x) => x.id === a.agentId)?.avatar ?? '🤖'} size={20} /><span className="truncate">{a.agentName || 'Removido'}</span></>} />
          )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
        </Card>
        <Card title="Modelos" subtitle="Custo e tokens por modelo">
          {data.models.length ? data.models.map((m) => (
            <RankRow key={m.runtime + m.model} share={m.costUsd / maxModel} value={money(m.costUsd)}
              sub={`${compact(m.inputTokens + m.cachedTokens + m.outputTokens)} tokens`}
              left={<><Cpu className="size-4 shrink-0 text-mute" /><span className="truncate">{m.model || 'padrão'}</span><span className="rounded bg-white/5 px-1.5 text-[10px] text-mute">{m.runtime === 'codex' ? 'Codex' : 'Claude'}</span></>} />
          )) : <p className="py-10 text-center text-mute">Nenhuma execução.</p>}
        </Card>
        <Card title="Quem mais pede" subtitle="Execuções disparadas por pessoa">
          {data.users.length ? data.users.map((u) => (
            <RankRow key={u.userId ?? 'sys'} share={u.runs / maxUser} value={String(u.runs)} sub={money(u.costUsd)}
              left={<><Avatar name={u.name} size={20} /><span className="truncate">{u.name}</span></>} />
          )) : <p className="py-10 text-center text-mute"><Users className="mx-auto mb-2 size-5" />Ninguém ainda.</p>}
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
    </div>
  );
}
