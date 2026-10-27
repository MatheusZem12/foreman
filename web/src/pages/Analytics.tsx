import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useWs } from '../components/Layout';
import { Avatar, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { compact, duration, money } from '../lib/format';
import { useAgents } from '../lib/queries';
import type { Analytics, Totals } from '../lib/types';

type Metric = 'tokens' | 'cost' | 'time' | 'runs';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'tokens', label: 'Tokens' },
  { id: 'cost', label: 'Custo' },
  { id: 'time', label: 'Tempo' },
  { id: 'runs', label: 'Execuções' }
];

const value = (t: Totals, m: Metric) =>
  m === 'tokens' ? t.inputTokens + t.cachedTokens + t.outputTokens : m === 'cost' ? t.costUsd : m === 'time' ? t.seconds : t.runs;
const fmt = (v: number, m: Metric) => (m === 'cost' ? money(v) : m === 'time' ? duration(v) : compact(v));

function Segmented<T extends string>({ items, value: v, onChange }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-line p-0.5">
      {items.map((i) => (
        <button key={i.id} onClick={() => onChange(i.id)} className={clsx('rounded px-2 py-0.5 text-xs', v === i.id ? 'bg-hover text-fg' : 'text-dim hover:text-fg')}>{i.label}</button>
      ))}
    </div>
  );
}

export function AnalyticsPage() {
  const { ws } = useWs();
  const [days, setDays] = useState('30');
  const [scope, setScope] = useState<'ws' | 'all'>('ws');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [asTable, setAsTable] = useState(false);
  const { data: agents = [] } = useAgents();
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', scope === 'ws' ? ws.id : '', days],
    queryFn: () => api.get<Analytics>(`/analytics?days=${days}&workspace=${scope === 'ws' ? ws.id : ''}`)
  });

  // Preenche os dias sem execução com zero, para o eixo do tempo ser contínuo.
  const series = useMemo(() => {
    if (!data) return [];
    const byDay = new Map(data.daily.map((d) => [d.day, d]));
    const out = [];
    for (let i = Number(days) - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const t = byDay.get(key);
      out.push({ day: key, v: t ? value(t, metric) : 0, t });
    }
    return out;
  }, [data, days, metric]);

  const t = data?.totals;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-lg font-semibold">Analytics</h1>
          <Segmented items={[{ id: 'ws', label: ws.name }, { id: 'all', label: 'Todos' }]} value={scope} onChange={setScope} />
          <Segmented items={[{ id: '7', label: '7d' }, { id: '30', label: '30d' }, { id: '90', label: '90d' }]} value={days} onChange={setDays} />
        </div>

        {isLoading || !t ? (
          <div className="grid h-60 place-items-center"><Spinner /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-panel md:grid-cols-4">
              <Tile label={`Custo · ${days}d`} value={money(t.costUsd)} sub={t.runs ? `${money(t.costUsd / t.runs)} por execução` : ''} />
              <Tile label={`Tokens · ${days}d`} value={compact(t.inputTokens + t.cachedTokens + t.outputTokens)} sub={`entrada ${compact(t.inputTokens)} · cache ${compact(t.cachedTokens)} · saída ${compact(t.outputTokens)}`} />
              <Tile label={`Tempo · ${days}d`} value={duration(t.seconds)} sub={`em ${t.runs} execuções`} />
              <Tile label={`Execuções · ${days}d`} value={String(t.runs)} sub={`${t.failed} falharam`} />
            </div>

            <section className="rounded-xl border border-line bg-panel p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto font-medium">{METRICS.find((m) => m.id === metric)!.label} por dia</h2>
                <Segmented items={METRICS} value={metric} onChange={setMetric} />
                <Segmented items={[{ id: 'chart', label: 'Gráfico' }, { id: 'table', label: 'Tabela' }]} value={asTable ? 'table' : 'chart'} onChange={(v) => setAsTable(v === 'table')} />
              </div>
              {asTable ? <DailyTable series={series} metric={metric} /> : <BarChart series={series} metric={metric} />}
            </section>

            <section className="rounded-xl border border-line bg-panel">
              <h2 className="border-b border-line px-4 py-3 font-medium">Por agente <span className="text-xs font-normal text-mute">· {METRICS.find((m) => m.id === metric)!.label.toLowerCase()}</span></h2>
              <Leaderboard rows={data!.agents} metric={metric} avatar={(id) => agents.find((a) => a.id === id)?.avatar} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value: v, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-b border-r border-line p-4 last:border-r-0 md:border-b-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-mute">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums md:text-3xl">{v}</div>
      {sub && <div className="mt-1 text-xs text-mute">{sub}</div>}
    </div>
  );
}

type Point = { day: string; v: number; t?: Totals };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

// Série única: uma cor, sem legenda (o título nomeia), tooltip por barra.
function BarChart({ series, metric }: { series: Point[]; metric: Metric }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = 220;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const max = niceMax(Math.max(...series.map((p) => p.v)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / series.length;
  const bw = Math.max(2, Math.min(28, slot - 2)); // 2px de respiro entre barras
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(series.length / 8);
  const h = hover != null ? series[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)} role="img" aria-label="Gráfico de barras diário">
        {ticks.map((v) => {
          const y = pad.t + ih - (v / max) * ih;
          return (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="rgb(var(--line))" strokeWidth="1" opacity={v === 0 ? 1 : 0.5} />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize="10" fill="rgb(var(--mute))">{fmt(v, metric)}</text>
            </g>
          );
        })}
        {series.map((p, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          const bh = (p.v / max) * ih;
          const y = pad.t + ih - bh;
          const r = Math.min(4, bw / 2, bh);
          return (
            <g key={p.day} onMouseEnter={() => setHover(i)}>
              {/* alvo de hover maior que a barra */}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
              {bh > 0 && (
                <path
                  d={`M${x},${y + bh} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + bh} Z`}
                  fill="rgb(var(--accent))"
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="rgb(var(--mute))">{p.day.slice(8, 10)}/{p.day.slice(5, 7)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: `${((pad.l + hover! * slot + slot / 2) / W) * 100}%`, transform: `translateX(${hover! > series.length / 2 ? '-105%' : '5%'})` }}
        >
          <div className="text-mute">{new Date(h.day + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</div>
          <div className="font-semibold tabular-nums">{fmt(h.v, metric)}</div>
          {h.t && <div className="text-mute">{h.t.runs} execuções · {money(h.t.costUsd)}</div>}
        </div>
      )}
    </div>
  );
}

function DailyTable({ series, metric }: { series: Point[]; metric: Metric }) {
  const rows = series.filter((p) => p.t).reverse();
  if (!rows.length) return <p className="py-6 text-center text-mute">Nenhuma execução no período.</p>;
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-mute"><tr className="border-b border-line"><th className="py-1.5">Dia</th><th className="text-right">{METRICS.find((m) => m.id === metric)!.label}</th><th className="text-right">Execuções</th><th className="text-right">Custo</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.day} className="border-b border-line/50">
              <td className="py-1.5">{p.day.split('-').reverse().join('/')}</td>
              <td className="text-right tabular-nums">{fmt(p.v, metric)}</td>
              <td className="text-right tabular-nums">{p.t!.runs}</td>
              <td className="text-right tabular-nums">{money(p.t!.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Leaderboard({ rows, metric, avatar }: { rows: Analytics['agents']; metric: Metric; avatar: (id: string | null) => string | undefined }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-mute">Nenhuma execução no período.</p>;
  const sorted = [...rows].sort((a, b) => value(b, metric) - value(a, metric));
  const max = Math.max(...sorted.map((r) => value(r, metric))) || 1;
  return (
    <div className="divide-y divide-line">
      {sorted.map((r) => (
        <div key={r.agentId ?? r.agentName} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[180px_1fr_repeat(4,80px)]">
          <div className="flex min-w-0 items-center gap-2"><Avatar emoji={avatar(r.agentId)} name={r.agentName} size={22} /><span className="truncate font-medium">{r.agentName || '(removido)'}</span></div>
          <div className="col-span-2 row-start-2 h-1.5 overflow-hidden rounded-full bg-hover md:col-span-1 md:row-start-auto">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(value(r, metric) / max) * 100}%` }} />
          </div>
          <div className="text-right text-xs tabular-nums md:hidden">{fmt(value(r, metric), metric)}</div>
          <div className="hidden text-right text-xs tabular-nums md:block">{compact(r.inputTokens + r.cachedTokens + r.outputTokens)}</div>
          <div className="hidden text-right text-xs tabular-nums md:block">{money(r.costUsd)}</div>
          <div className="hidden text-right text-xs tabular-nums md:block">{duration(r.seconds)}</div>
          <div className="hidden text-right text-xs tabular-nums md:block">{r.runs} <span className="text-mute">exec.</span></div>
        </div>
      ))}
    </div>
  );
}
