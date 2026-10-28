import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { Activity, AlertTriangle, BarChart3, Bot, ChevronDown, Globe2, CheckCircle2, Clock, Coins, Cpu, Sparkles, Table2, Users, Zap } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, Chip, EmptyState, MenuItem, PageHeader, Popover, PriorityIcon, Spinner, StatusIcon } from '../components/ui';
import { api } from '../lib/api';
import { PRIORITIES, STATUSES, statusOf } from '../lib/constants';
import { compact, duration, money } from '../lib/format';
import { useAgents, useCan, useMe, useMembers, useUsers } from '../lib/queries';
import type { Agent, Analytics, StageKind, Totals } from '../lib/types';
import { AgentIcon } from '../components/AgentIcon';
import { lang, locale, t } from '../lib/i18n';

// Paleta categórica validada (daltonismo + contraste) para a superfície escura.
const C1 = 'var(--chart-1)';
const C3 = 'var(--chart-3)';
const AXIS = { fontSize: 11, fill: 'rgb(var(--mute))' };
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(locale, { month: 'short' }).replace('.', ''));
const monthLabel = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] + '/' + m.slice(2, 4);
const dayLabel = (d: string) => (lang === 'en' ? `${d.slice(5, 7)}/${d.slice(8, 10)}` : `${d.slice(8, 10)}/${d.slice(5, 7)}`);

type Metric = 'cost' | 'tokens' | 'runs' | 'time';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: t('Custo') },
  { id: 'tokens', label: t('Tokens') },
  { id: 'runs', label: t('Execuções') },
  { id: 'time', label: t('Tempo') }
];
const metricOf = (tt: Totals | undefined, m: Metric) =>
  !tt ? 0 : m === 'cost' ? tt.costUsd : m === 'tokens' ? tt.inputTokens + tt.cachedTokens + tt.outputTokens : m === 'runs' ? tt.runs : tt.seconds;
const fmtMetric = (v: number, m: Metric) => (m === 'cost' ? money(v) : m === 'time' ? duration(v) : compact(v));
const hours = (h: number) => (!h ? '—' : h < 1 ? t('{0} min', Math.round(h * 60)) : h < 48 ? `${h.toFixed(1)} h` : t('{0} dias', (h / 24).toFixed(1)));

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

// Dois níveis: o Analytics do workspace em que a pessoa está (analytics.view)
// e o geral, de todos os workspaces que ela enxerga (analytics.global). Em
// cada um, ver os números de todo mundo ou de outra pessoa é uma permissão à
// parte (analytics.team / analytics.global_team); sem ela, só os próprios.
export function AnalyticsPage({ global }: { global?: boolean }) {
  const { ws } = useWs();
  const { data: me } = useMe();
  const team = useCan(global ? 'analytics.global_team' : 'analytics.team');
  const [person, setPerson] = useState<string>(team ? 'all' : 'me');
  const [days, setDays] = useState<'7' | '30' | '90' | '365'>('30');
  const [metric, setMetric] = useState<Metric>('cost');
  const [table, setTable] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('mx.analyticsTab') as Tab) || 'geral';
    } catch {
      return 'geral';
    }
  });
  const pick = (tt: Tab) => {
    setTab(tt);
    try {
      localStorage.setItem('mx.analyticsTab', tt);
    } catch {
      /* sem storage */
    }
  };
  const { data: agents = [] } = useAgents();
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', global ? 'global' : ws.id, days, person],
    queryFn: () => api.get<Analytics>(`${global ? '' : `/workspaces/${ws.id}`}/analytics?days=${days}&person=${person}`)
  });

  // Dias sem execução entram com zero: o eixo do tempo fica contínuo.
  const daily = useMemo<Day[]>(() => {
    if (!data) return [];
    const by = new Map(data.daily.map((d) => [d.day, d]));
    return Array.from({ length: Number(days) }, (_, k) => {
      const d = new Date();
      d.setDate(d.getDate() - (Number(days) - 1 - k));
      const key = d.toISOString().slice(0, 10);
      const tt = by.get(key);
      return { day: key, value: metricOf(tt, metric), cost: tt?.costUsd ?? 0, runs: tt?.runs ?? 0, tt };
    });
  }, [data, days, metric]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="page">
        <PageHeader
          icon={global ? Globe2 : BarChart3}
          title={global ? t('Analytics geral') : t('Analytics')}
          description={global ? t('Todos os workspaces a que você tem acesso, somados.') : t('Custo, volume e ritmo das issues e dos agentes de {0}.', ws.name)}
          actions={
            <div className="flex flex-wrap gap-2">
              <PersonPicker global={global} team={team} value={person} onChange={setPerson} meId={me?.id} />
              <Segmented items={[{ id: '7', label: '7d' }, { id: '30', label: '30d' }, { id: '90', label: '90d' }, { id: '365', label: t('1 ano') }]} value={days} onChange={setDays} />
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
  const tt = data.totals;
  const tokens = tt.inputTokens + tt.cachedTokens + tt.outputTokens;
  const success = tt.runs ? Math.round(((tt.runs - tt.failed) / tt.runs) * 100) : 0;
  const cacheShare = tokens ? Math.round((tt.cachedTokens / tokens) * 100) : 0;
  const monthly = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const status = STATUSES.map((s) => ({ ...s, value: data.status.find((x) => x.status === s.id)?.count ?? 0 })).filter((s) => s.value > 0);
  const statusTotal = status.reduce((a, s) => a + s.value, 0);
  const maxAgent = Math.max(...data.agents.map((a) => a.costUsd), 1e-6);
  const maxModel = Math.max(...data.models.map((a) => a.costUsd), 1e-6);
  const maxUser = Math.max(...data.users.map((u) => u.runs), 1);

  if (!tt.runs && !data.issues.created && !data.issues.open) {
    return (
      <EmptyState icon={Sparkles} title={t('Ainda não há dados')} action={<Link to={`/w/${wsKey}`} className="text-sm text-accent hover:underline">{t('Ir para o quadro')}</Link>}>
        {t('Crie issues e rode os agentes: custo, issues resolvidas por mês e o ranking de agentes e modelos aparecem aqui.')}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      {tab === 'geral' && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi icon={Coins} label={t('Custo · {0}d', days)} value={money(tt.costUsd)} sub={t('{0} por execução', money(tt.runs ? tt.costUsd / tt.runs : 0))} spark={daily.map((d) => d.cost)} />
        <Kpi icon={CheckCircle2} label={t('Issues resolvidas')} value={String(data.issues.resolved)} sub={t('{0} criadas · {1} abertas', data.issues.created, data.issues.open)} />
        <Kpi icon={Activity} label={t('Execuções')} value={compact(tt.runs)} sub={<><span className={success >= 80 ? 'text-emerald-400' : 'text-amber-400'}>{success}%</span> {t('com sucesso')}</>} spark={daily.map((d) => d.runs)} color={C3} />
        <Kpi icon={Clock} label={t('Tempo até resolver')} value={hours(data.issues.avgResolveHours)} sub={t('mediana {0} · agentes {1}', hours(data.issues.medResolveHours), duration(tt.seconds))} />
        <Kpi icon={Zap} label={t('Tokens')} value={compact(tokens)} sub={t('{0}% vieram do cache', cacheShare)} className="col-span-2 lg:col-span-1" />
      </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('Issues por mês')} subtitle={t('Criadas × resolvidas, últimos 12 meses')} className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={monthly} barGap={2} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgb(var(--ink) / 0.04)' }} content={<Tip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: 'rgb(var(--dim))' }} />
                <Bar animationDuration={500} dataKey="created" name="Criadas" fill={C1} radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar animationDuration={500} dataKey="resolved" name="Resolvidas" fill={C3} radius={[4, 4, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title={t('Status')} subtitle={t('Abertas agora + encerradas no período')}>
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
                  <div><div className="text-2xl font-semibold tabular-nums">{statusTotal}</div><div className="text-[11px] text-mute">{t('issues')}</div></div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {status.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5"><StatusIcon status={s.id} /><span className="text-dim">{s.label}</span><span className="ml-auto tabular-nums">{s.value}</span></div>
                ))}
              </div>
            </div>
          ) : <p className="py-16 text-center text-mute">{t('Sem issues.')}</p>}
        </Card>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title={t('Atividade diária')}
          subtitle={t('Últimos {0} dias', days)}
          className="lg:col-span-3"
          actions={
            <div className="flex gap-2">
              <Segmented items={METRICS} value={metric} onChange={setMetric} />
              <button onClick={() => setTable(!table)} title={t('Ver como tabela')} className={clsx('rounded-lg border border-line p-1.5', table ? 'bg-white/10 text-fg' : 'text-mute hover:text-fg')}><Table2 className="size-3.5" /></button>
            </div>
          }
        >
          {table ? (
            <div className="max-h-56 overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-panel text-left text-mute"><tr><th className="py-1.5 font-medium">{t('Dia')}</th><th className="font-medium">{t('Execuções')}</th><th className="font-medium">{t('Custo')}</th><th className="font-medium">{t('Tokens')}</th><th className="font-medium">{t('Tempo')}</th></tr></thead>
                <tbody>
                  {[...daily].reverse().filter((d) => d.t).map((d) => (
                    <tr key={d.day} className="border-t border-line/60 tabular-nums">
                      <td className="py-1.5">{dayLabel(d.day)}</td><td>{d.runs}</td><td>{money(d.cost)}</td><td>{compact(metricOf(d.t, 'tokens'))}</td><td>{duration(d.t!.seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!daily.some((d) => d.t) && <p className="py-8 text-center text-mute">{t('Nenhuma execução no período.')}</p>}
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
                  <Tooltip cursor={{ stroke: 'rgb(var(--ink) / 0.15)' }} content={<Tip format={(v) => fmtMetric(v, metric)} labelFormat={dayLabel} />} />
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
          <Kpi icon={Coins} label={t('Custo · {0}d', days)} value={money(tt.costUsd)} sub={t('{0} por execução', money(tt.runs ? tt.costUsd / tt.runs : 0))} spark={daily.map((d) => d.cost)} />
          <Kpi icon={CheckCircle2} label={t('Custo por issue resolvida')} value={money(data.issues.resolved ? tt.costUsd / data.issues.resolved : 0)} sub={t('{0} resolvidas', data.issues.resolved)} />
          <Kpi icon={Zap} label={t('Tokens')} value={compact(tokens)} sub={t('{0}% vieram do cache', cacheShare)} />
          <Kpi icon={Cpu} label={t('Modelos usados')} value={String(data.models.length)} sub={t('{0} agente(s)', data.agents.length)} />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('Custo por mês')} subtitle={t('Últimos 12 meses')} className="lg:col-span-2">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={monthly} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => money(v)} />
                <Tooltip cursor={{ fill: 'rgb(var(--ink) / 0.04)' }} content={<Tip format={money} />} />
                <Bar animationDuration={500} dataKey="costUsd" name="Custo" fill={C1} radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
          <CostByPriority data={data} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <CostByCreator data={data} />
        <Card title={t('Modelos')} subtitle={t('Custo e tokens por modelo')}>
          {data.models.length ? data.models.map((m) => (
            <RankRow key={m.runtime + m.model} share={m.costUsd / maxModel} value={money(m.costUsd)}
              sub={t('{0} tokens', compact(m.inputTokens + m.cachedTokens + m.outputTokens))}
              left={<><Cpu className="size-4 shrink-0 text-mute" /><span className="truncate">{m.model || t('padrão')}</span><span className="rounded bg-white/5 px-1.5 text-[10px] text-mute">{m.runtime === 'codex' ? t('Codex') : t('Claude')}</span></>} />
          )) : <p className="py-10 text-center text-mute">{t('Nenhuma execução.')}</p>}
        </Card>
        </div>
        <Card title={t('Issues mais caras')} subtitle={t('No período')}>
          {data.top.length ? (
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="text-xs text-mute"><tr><th className="px-4 py-2 font-medium">{t('Issue')}</th><th className="px-4 font-medium">{t('Status')}</th><th className="px-4 text-right font-medium">{t('Execuções')}</th><th className="px-4 text-right font-medium">{t('Custo')}</th></tr></thead>
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
          ) : <p className="py-8 text-center text-mute">{t('Nenhuma execução no período.')}</p>}
        </Card>
      </>}

      {tab === 'pessoas' && <>
        <PeopleTab data={data} />
        <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('Quem mais pede')} subtitle={t('Execuções disparadas por pessoa')}>
          {data.users.length ? data.users.map((u) => (
            <RankRow key={u.userId ?? 'sys'} share={u.runs / maxUser} value={String(u.runs)} sub={money(u.costUsd)}
              left={<><Avatar name={u.name} size={20} /><span className="truncate">{u.name}</span></>} />
          )) : <p className="py-10 text-center text-mute"><Users className="mx-auto mb-2 size-5" />{t('Ninguém ainda.')}</p>}
        </Card>
          <CostByCreator data={data} />
        </div>
      </>}

      {tab === 'agentes' && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi icon={Activity} label={t('Execuções')} value={compact(tt.runs)} sub={<><span className={success >= 80 ? 'text-emerald-400' : 'text-amber-400'}>{success}%</span> {t('com sucesso')}</>} spark={daily.map((d) => d.runs)} color={C3} />
          <Kpi icon={Clock} label={t('Tempo médio por execução')} value={duration(tt.runs ? tt.seconds / tt.runs : 0)} sub={t('{0} no total', duration(tt.seconds))} />
          <Kpi icon={Coins} label={t('Custo por execução')} value={money(tt.runs ? tt.costUsd / tt.runs : 0)} sub={t('{0} falha(s)', tt.failed)} />
          <Kpi icon={Zap} label={t('Tokens por execução')} value={compact(tt.runs ? tokens / tt.runs : 0)} sub={t('{0}% do cache', cacheShare)} />
        </div>
        <AgentTable data={data} agents={agents} />
        <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('Agentes')} subtitle={t('Custo no período')}>
          {data.agents.length ? data.agents.map((a) => (
            <RankRow key={a.agentId ?? a.agentName} share={a.costUsd / maxAgent} value={money(a.costUsd)}
              sub={t('{0} exec. · {1}% ok', a.runs, a.runs ? Math.round(((a.runs - a.failed) / a.runs) * 100) : 0)}
              left={<><AgentIcon avatar={agents.find((x) => x.id === a.agentId)?.avatar} size={20} /><span className="truncate">{a.agentName || t('Removido')}</span></>} />
          )) : <p className="py-10 text-center text-mute">{t('Nenhuma execução.')}</p>}
        </Card>
        <Card title={t('Modelos')} subtitle={t('Custo e tokens por modelo')}>
          {data.models.length ? data.models.map((m) => (
            <RankRow key={m.runtime + m.model} share={m.costUsd / maxModel} value={money(m.costUsd)}
              sub={t('{0} tokens', compact(m.inputTokens + m.cachedTokens + m.outputTokens))}
              left={<><Cpu className="size-4 shrink-0 text-mute" /><span className="truncate">{m.model || t('padrão')}</span><span className="rounded bg-white/5 px-1.5 text-[10px] text-mute">{m.runtime === 'codex' ? t('Codex') : t('Claude')}</span></>} />
          )) : <p className="py-10 text-center text-mute">{t('Nenhuma execução.')}</p>}
        </Card>
        </div>
      </>}
    </div>
  );
}

// ---------- abas focadas ----------

type Tab = 'geral' | 'tempo' | 'custos' | 'pessoas' | 'agentes';
const TABS: { id: Tab; label: string; icon: typeof Clock; hint: string }[] = [
  { id: 'geral', label: t('Visão geral'), icon: BarChart3, hint: t('Volume, status e atividade') },
  { id: 'tempo', label: t('Tempo'), icon: Clock, hint: t('Ciclo, etapas e gargalos') },
  { id: 'custos', label: t('Custos'), icon: Coins, hint: t('Onde o dinheiro vai') },
  { id: 'pessoas', label: t('Pessoas'), icon: Users, hint: t('Desempenho de cada um') },
  { id: 'agentes', label: t('Agentes'), icon: Bot, hint: t('Eficiência dos agentes e modelos') }
];

// Tipo de cada etapa, tirado das regras do fluxo (o servidor classifica).
const KINDS: Record<StageKind, { label: () => string; hint: () => string; color: string }> = {
  ai: { label: () => t('IA trabalhando'), hint: () => t('etapas em que o agente trabalha'), color: 'rgb(var(--accent))' },
  people: { label: () => t('Esperando pessoas'), hint: () => t('a IA pediu algo e alguém precisa responder'), color: '#fb923c' },
  approval: { label: () => t('Aprovação'), hint: () => t('etapas com regra de aprovação'), color: '#34d399' },
  queue: { label: () => t('Fila e trabalho manual'), hint: () => t('o resto: backlog, fila, etapas manuais'), color: 'rgb(var(--mute))' },
  closed: { label: () => t('Encerrada'), hint: () => '', color: 'rgb(var(--line))' }
};

function KindBreakdown({ data }: { data: Analytics }) {
  const kt = data.kindTimes ?? [];
  const total = kt.reduce((a, k) => a + k.hours, 0);
  return (
    <Card title={t('Onde o tempo vai')} subtitle={t('Tempo somado por tipo de etapa. O tipo vem das regras do seu fluxo: onde o agente trabalha, onde a IA espera alguém, onde há aprovação.')}>
      {total > 0 ? (
        <div className="space-y-3">
          <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
            {kt.map((k) => <div key={k.kind} title={KINDS[k.kind].label()} style={{ width: `${(k.hours / total) * 100}%`, background: KINDS[k.kind].color }} />)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {kt.map((k) => (
              <div key={k.kind} className="flex items-start gap-2 text-[13px]">
                <span className="mt-1 size-2.5 shrink-0 rounded-sm" style={{ background: KINDS[k.kind].color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2"><span>{KINDS[k.kind].label()}</span><span className="tabular-nums text-dim">{Math.round((k.hours / total) * 100)}%</span></div>
                  <div className="text-[11px] text-mute">{t('{0} no total · {1} por passagem', hours(k.hours), hours(k.avgHours))} · {KINDS[k.kind].hint()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : <p className="py-8 text-center text-mute">{t('Ainda sem passagens completas por etapas.')}</p>}
    </Card>
  );
}

function TimeTab({ data }: { data: Analytics }) {
  const st = data.stageTimes ?? [];
  const maxSt = Math.max(...st.map((s) => s.avgHours), 0.0001);
  const slowest = st.reduce<typeof st[number] | null>((a, b) => (!a || b.avgHours > a.avgHours ? b : a), null);
  const pr = [...(data.priorities ?? [])].sort((a, b) => a.priority - b.priority);
  const maxPr = Math.max(...pr.map((p) => p.avgSeconds), 0.0001);
  const people = (data.people ?? []).filter((p) => p.replyHours > 0).sort((a, b) => b.replyHours - a.replyHours);
  const maxReply = Math.max(...people.map((p) => p.replyHours), 0.0001);
  const tt = data.totals;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Clock} label={t('Criação → conclusão')} value={hours(data.issues.avgResolveHours)} sub={t('mediana {0}', hours(data.issues.medResolveHours))} />
        <Kpi icon={CheckCircle2} label={t('Resolvidas no período')} value={String(data.issues.resolved)} sub={t('{0} abertas agora', data.issues.open)} />
        <Kpi icon={AlertTriangle} label={t('Gargalo')} value={slowest ? t(slowest.name) : '—'} sub={slowest ? t('{0} em média', hours(slowest.avgHours)) : t('sem dados ainda')} />
        <Kpi icon={Bot} label={t('Tempo de agente')} value={duration(tt.seconds)} sub={t('{0} por execução', duration(tt.runs ? tt.seconds / tt.runs : 0))} />
      </div>
      <KindBreakdown data={data} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('Tempo por etapa')} subtitle={t('Média de permanência em cada etapa (mediana ao lado)')} className="lg:col-span-2">
          {st.length ? st.map((s) => (
            <RankRow key={s.stage} share={s.avgHours / maxSt} value={hours(s.avgHours)} sub={t('mediana {0} · {1}×', hours(s.medHours), s.passes)}
              left={<><StatusIcon status={s.stage} /><span className="truncate">{t(s.name)}</span>
                {s.kind && s.kind !== 'queue' && <span className="shrink-0 rounded px-1 text-[10px]" style={{ color: KINDS[s.kind]?.color, background: 'rgb(var(--ink) / 0.05)' }}>{KINDS[s.kind]?.label()}</span>}</>} />
          )) : <p className="py-10 text-center text-mute">{t('Ainda sem passagens completas por etapas.')}</p>}
        </Card>
        <Card title={t('Tempo de agente por prioridade')} subtitle={t('Duração média de cada execução')}>
          {pr.length ? pr.map((p) => (
            <RankRow key={p.priority} share={p.avgSeconds / maxPr} value={duration(p.avgSeconds)} sub={t('{0} exec.', p.runs)}
              left={<><PriorityIcon priority={p.priority} /><span className="truncate">{PRIORITIES.find((x) => x.id === p.priority)?.label}</span></>} />
          )) : <p className="py-10 text-center text-mute">{t('Nenhuma execução.')}</p>}
        </Card>
      </div>
      <Card title={t('Tempo de resposta')} subtitle={t('Quanto as issues de cada pessoa ficam esperando alguém responder à IA (etapas que as suas regras usam para isso)')}>
        {people.length ? people.map((p) => (
          <RankRow key={p.userId} share={p.replyHours / maxReply} value={hours(p.replyHours)}
            left={<><Avatar name={p.name} size={20} /><span className="truncate">{p.name}</span></>} />
        )) : <p className="py-8 text-center text-mute">{t('Ninguém precisou responder à IA no período.')}</p>}
      </Card>
    </>
  );
}

function CostByPriority({ data }: { data: Analytics }) {
  const pr = [...(data.priorities ?? [])].sort((a, b) => b.costUsd - a.costUsd);
  const max = Math.max(...pr.map((p) => p.costUsd), 0.0001);
  return (
    <Card title={t('Custo por prioridade')} subtitle={t('Quanto cada urgência consome')}>
      {pr.length ? pr.map((p) => (
        <RankRow key={p.priority} share={p.costUsd / max} value={money(p.costUsd)} sub={t('{0} issue(s) · {1}/issue', p.issues, money(p.issues ? p.costUsd / p.issues : 0))}
          left={<><PriorityIcon priority={p.priority} /><span className="truncate">{PRIORITIES.find((x) => x.id === p.priority)?.label ?? '—'}</span></>} />
      )) : <p className="py-10 text-center text-mute">{t('Nenhuma execução.')}</p>}
    </Card>
  );
}

function CostByCreator({ data }: { data: Analytics }) {
  const cr = data.creators ?? [];
  const max = Math.max(...cr.map((c) => c.costUsd), 0.0001);
  return (
    <Card title={t('Custo por quem criou')} subtitle={t('Issues de cada pessoa, somando todas as execuções')}>
      {cr.length ? cr.map((c) => (
        <RankRow key={c.userId ?? 'ext'} share={c.costUsd / max} value={money(c.costUsd)} sub={t('{0} exec.', c.runs)}
          left={<><Avatar name={c.name} size={20} /><span className="truncate">{c.name}</span></>} />
      )) : <p className="py-10 text-center text-mute">{t('Ninguém ainda.')}</p>}
    </Card>
  );
}

type SortKey = 'created' | 'resolved' | 'openAssigned' | 'resolveHours' | 'replyHours' | 'comments' | 'approvals' | 'runs' | 'costUsd';

// Uma linha por pessoa: o que criou, resolveu, quanto demora e quanto custa.
function PeopleTab({ data }: { data: Analytics }) {
  const [sort, setSort] = useState<SortKey>('resolved');
  const people = [...(data.people ?? [])].sort((a, b) => (b[sort] as number) - (a[sort] as number));
  const cols: [SortKey, string, (p: Analytics['people'][number]) => string][] = [
    ['created', t('Criou'), (p) => String(p.created)],
    ['openAssigned', t('Abertas c/ ela'), (p) => String(p.openAssigned)],
    ['resolved', t('Resolveu'), (p) => String(p.resolved)],
    ['resolveHours', t('Tempo p/ resolver'), (p) => hours(p.resolveHours)],
    ['replyHours', t('Tempo de resposta'), (p) => hours(p.replyHours)],
    ['comments', t('Comentários'), (p) => String(p.comments)],
    ['approvals', t('Aprovações'), (p) => String(p.approvals)],
    ['runs', t('Pedidos ao agente'), (p) => String(p.runs)],
    ['costUsd', t('Custo'), (p) => money(p.costUsd)]
  ];
  return (
    <Card title={t('Desempenho por pessoa')} subtitle={t('No período · clique numa coluna para ordenar · “resolveu” conta as issues em que a pessoa é a responsável')}>
      {people.length ? (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-mute">
              <tr>
                <th className="px-4 py-2 font-medium">{t('Pessoa')}</th>
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
      ) : <p className="py-10 text-center text-mute"><Users className="mx-auto mb-2 size-5" />{t('Ninguém teve atividade no período.')}</p>}
    </Card>
  );
}

// Eficiência de cada agente: sucesso, tempo e custo por execução.
function AgentTable({ data, agents }: { data: Analytics; agents: Agent[] }) {
  return (
    <Card title={t('Eficiência por agente')} subtitle={t('No período')}>
      {data.agents.length ? (
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-mute">
              <tr>{[t('Agente'), t('Execuções'), t('Sucesso'), t('Tempo médio'), t('Custo/execução'), t('Tokens/execução'), t('Custo total')].map((h, i) => <th key={h} className={clsx('whitespace-nowrap py-2 font-medium', i ? 'px-3 text-right' : 'px-4')}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.agents.map((a) => {
                const ok = a.runs ? Math.round(((a.runs - a.failed) / a.runs) * 100) : 0;
                return (
                  <tr key={a.agentId ?? a.agentName} className="border-t border-line/60 hover:bg-white/[0.03]">
                    <td className="whitespace-nowrap px-4 py-2.5"><span className="inline-flex items-center gap-2"><AgentIcon avatar={agents.find((x) => x.id === a.agentId)?.avatar} size={20} /> {a.agentName || t('Removido')}</span></td>
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
      ) : <p className="py-10 text-center text-mute">{t('Nenhuma execução.')}</p>}
    </Card>
  );
}

// De quem são os números: só os meus, de todo mundo ou de uma pessoa (com a permissão de equipe).
function PersonPicker({ global, team, value, onChange, meId }: { global?: boolean; team: boolean; value: string; onChange: (v: string) => void; meId?: string }) {
  const { ws } = useWs();
  const canUsers = useCan('user.view');
  const { data: members = [] } = useMembers(ws.id);
  const { data: users = [] } = useUsers(global && canUsers && team);
  const people = (global && canUsers ? users : members).filter((p) => p.id !== meId);
  if (!team) return <span className="inline-flex h-8 items-center rounded-lg border border-line px-2.5 text-xs text-mute" title={t('Seu perfil vê só os próprios números')}>{t('Seus números')}</span>;
  const label = value === 'all' ? t('Todo mundo') : value === 'me' ? t('Só eu') : people.find((p) => p.id === value)?.name ?? t('Pessoa');
  return (
    <Popover align="right" trigger={() => <Chip>{label} <ChevronDown className="size-3.5 text-mute" /></Chip>}>
      {(close) => (
        <div className="max-h-80 overflow-y-auto">
          <MenuItem selected={value === 'all'} onClick={() => { onChange('all'); close(); }}>{t('Todo mundo')}</MenuItem>
          <MenuItem selected={value === 'me'} onClick={() => { onChange('me'); close(); }}>{t('Só eu')}</MenuItem>
          {people.length > 0 && <div className="px-2 pb-1 pt-2 text-[11px] text-mute">{t('Uma pessoa')}</div>}
          {people.map((p) => (
            <MenuItem key={p.id} selected={value === p.id} onClick={() => { onChange(p.id); close(); }}>
              <Avatar name={p.name} size={18} /> {p.name}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}
