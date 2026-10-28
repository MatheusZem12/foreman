import { useMemo, useState } from 'react';
import dagre from '@dagrejs/dagre';
import clsx from 'clsx';
import { Lock, Sparkles, UserCheck, Zap } from 'lucide-react';
import { StatusIcon, Toggle } from '../components/ui';
import { PRIORITIES, stageGroups } from '../lib/constants';
import type { Rule, Stage } from '../lib/types';

// Mapa do fluxo, de cima para baixo. O layout é do dagre (grafo em camadas):
// ele distribui as etapas, separa as setas e reserva lugar para os rótulos,
// então nada passa por cima de etapa nem de texto. Etapas em paralelo caem
// na mesma camada (lado a lado).

type Kind = 'seq' | 'rule' | 'approve' | 'system';
interface Edge { from: string; to: string; kind: Kind; label: string }

const NODE_W = 172, NODE_H = 50, START_W = 120, START_H = 34;
const COLORS: Record<Kind, string> = { seq: 'rgb(255 255 255 / 0.16)', rule: '#9d8cff', approve: '#34d399', system: '#e0a43a' };
const START = '__start';

const SYSTEM_EDGES: Edge[] = [
  { from: 'todo', to: 'in_progress', kind: 'system', label: 'agente começa' },
  { from: 'in_progress', to: 'in_review', kind: 'system', label: 'IA concluiu' },
  { from: 'in_progress', to: 'waiting', kind: 'system', label: 'IA precisa de você' },
  { from: 'in_progress', to: 'blocked', kind: 'system', label: 'falhou' },
  { from: 'waiting', to: 'in_progress', kind: 'system', label: 'você respondeu' }
];

function condLabel(r: Rule) {
  const c = r.conditions ?? {};
  const parts: string[] = [];
  if (r.trigger === 'leave') parts.push('ao sair');
  if (r.trigger === 'stale') parts.push(`parada ${c.hours ?? '?'}h`);
  if (c.priorities?.length) parts.push(c.priorities.map((p) => PRIORITIES.find((x) => x.id === p)?.label).join('/'));
  if (c.labels?.length) parts.push(`${c.labels.length} label(s)`);
  if (c.agents?.length) parts.push('por agente');
  if (c.actorRoles?.length) parts.push('por perfil');
  return parts.join(' · ') || r.name || 'sempre';
}

// Curva suave passando pelos pontos do dagre (quadráticas pelos pontos médios).
function smooth(pts: { x: number; y: number }[]) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x},${pts[i].y} ${mx},${my}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last.x},${last.y}`;
}

export function FlowMap({ stages, rules }: { stages: Stage[]; rules: Rule[] }) {
  const [system, setSystem] = useState(true);
  const [showSeq, setShowSeq] = useState(true);

  const layout = useMemo(() => {
    const ids = new Set(stages.map((s) => s.id));
    const edges: Edge[] = [];
    const loose: Rule[] = [];
    for (const r of rules) {
      if (!r.enabled || r.action !== 'move' || !r.config?.to || !ids.has(r.config.to)) continue;
      if (['enter', 'leave', 'stale'].includes(r.trigger) && ids.has(r.stage)) edges.push({ from: r.stage, to: r.config.to, kind: 'rule', label: condLabel(r) });
      else if (r.trigger === 'created') edges.push({ from: START, to: r.config.to, kind: 'rule', label: condLabel(r) === 'sempre' ? 'issue criada' : condLabel(r) });
      else loose.push(r);
    }
    for (const s of stages) {
      const p = s.policy;
      if (p?.approvals && ids.has(p.approveTo || 'done')) {
        edges.push({ from: s.id, to: p.approveTo || 'done', kind: 'approve', label: `✓ ${p.approvals} aprovação${p.approvals > 1 ? 'ões' : ''}` });
      }
    }
    if (system) edges.push(...SYSTEM_EDGES.filter((e) => ids.has(e.from) && ids.has(e.to)));
    const visible = stages.filter((s) => s.id !== 'cancelled' || edges.some((e) => e.to === 'cancelled' || e.from === 'cancelled'));
    const groups = stageGroups(visible);
    // A ordem do quadro liga cada degrau ao próximo e segura a ordem vertical
    // no layout (peso alto), mesmo quando está escondida.
    const has = (a: string, b: string) => edges.some((e) => e.from === a && e.to === b);
    const seq: Edge[] = [];
    for (const t of groups[0] ?? []) if (!has(START, t.id)) seq.push({ from: START, to: t.id, kind: 'seq', label: '' });
    for (let i = 0; i + 1 < groups.length; i++)
      for (const a of groups[i]) for (const b of groups[i + 1]) if (!has(a.id, b.id)) seq.push({ from: a.id, to: b.id, kind: 'seq', label: '' });

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 46, edgesep: 20, marginx: 24, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    g.setNode(START, { width: START_W, height: START_H });
    for (const s of visible) g.setNode(s.id, { width: NODE_W, height: NODE_H });
    const all = [...seq, ...edges.filter((e) => g.hasNode(e.from) && g.hasNode(e.to) && e.from !== e.to)];
    all.forEach((e, i) => {
      const label = e.label ? { width: e.label.length * 6.1 + 18, height: 20, labelpos: 'c' } : {};
      g.setEdge(e.from, e.to, { ...label, weight: e.kind === 'seq' ? 6 : 1, minlen: 1 }, `e${i}`);
    });
    dagre.layout(g);
    const out = all.map((e, i) => ({ e, data: g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points: { x: number; y: number }[]; x?: number; y?: number } }));
    const nodes = [START, ...visible.map((s) => s.id)].map((id) => ({ id, ...(g.node(id) as { x: number; y: number; width: number; height: number }) }));
    const graph = g.graph() as { width?: number; height?: number };
    return { edges: out, nodes, width: graph.width ?? 400, height: graph.height ?? 300, loose };
  }, [stages, rules, system]);

  const byId = new Map(stages.map((s) => [s.id, s]));
  const stageRules = (id: string) => rules.filter((r) => r.stage === id && r.enabled);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-mute">
        {([['seq', 'ordem do quadro'], ['rule', 'regra de mover'], ['approve', 'aprovação'], ['system', 'automático do sistema']] as [Kind, string][]).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={k === 'seq' ? 'rgb(255 255 255 / 0.4)' : COLORS[k]} strokeWidth="2" strokeDasharray={k === 'seq' ? '3 3' : k === 'system' ? '5 3' : undefined} /></svg>{label}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-4">
          <Toggle checked={showSeq} onChange={setShowSeq} label="Ordem do quadro" />
          <Toggle checked={system} onChange={setSystem} label="O que o sistema faz sozinho" />
        </span>
      </div>
      <div className="surface overflow-auto">
        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
          <svg className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height}>
            <defs>
              {(Object.keys(COLORS) as Kind[]).map((k) => (
                <marker key={k} id={`fm-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M1,1.5 L9,5 L1,8.5 Z" fill={k === 'seq' ? 'rgb(255 255 255 / 0.3)' : COLORS[k]} />
                </marker>
              ))}
            </defs>
            {/* Ordem do quadro por baixo, regras por cima. */}
            {[...layout.edges].sort((a, b) => (a.e.kind === 'seq' ? -1 : 0) - (b.e.kind === 'seq' ? -1 : 0)).map(({ e, data }, i) => (
              (e.kind !== 'seq' || showSeq) && (
                <path key={i} d={smooth(data.points)} fill="none" stroke={COLORS[e.kind]}
                  strokeWidth={e.kind === 'seq' ? 1.25 : 1.75} strokeLinecap="round"
                  strokeDasharray={e.kind === 'seq' ? '3 4' : e.kind === 'system' ? '6 4' : undefined}
                  markerEnd={`url(#fm-${e.kind})`} />
              )
            ))}
          </svg>
          {layout.edges.filter(({ e, data }) => e.label && data.x !== undefined).map(({ e, data }, i) => (
            <span key={`l${i}`} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-2 py-px text-[10px] font-medium leading-4"
              style={{ left: data.x, top: data.y, color: COLORS[e.kind], borderColor: `${COLORS[e.kind]}40`, background: 'rgb(var(--panel))' }}>
              {e.label}
            </span>
          ))}
          {layout.nodes.map((n) => {
            const left = n.x - n.width / 2, top = n.y - n.height / 2;
            if (n.id === START) {
              return <div key={n.id} className="absolute flex items-center justify-center rounded-full border border-dashed border-white/25 bg-panel text-[12px] text-dim"
                style={{ left, top, width: n.width, height: n.height }}>Nova issue</div>;
            }
            const s = byId.get(n.id)!;
            const rs = stageRules(s.id);
            const ai = rs.some((r) => r.action === 'run_agent');
            const locked = !!(s.policy?.act?.roles?.length || s.policy?.act?.users?.length || s.policy?.readOnly);
            return (
              <div key={n.id} title={rs.length ? `${rs.length} regra(s) nesta etapa` : undefined}
                className={clsx('absolute flex flex-col justify-center rounded-xl border bg-card px-3 shadow-[0_8px_24px_-14px_rgb(0_0_0/0.9)]', s.parallel ? 'border-white/15' : 'border-white/[0.09]')}
                style={{ left, top, width: n.width, height: n.height, boxShadow: `inset 3px 0 0 0 ${s.color}` }}>
                <div className="flex items-center gap-1.5 text-[13px] font-medium"><StatusIcon status={s.id} /><span className="truncate">{s.name}</span></div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-mute">
                  {rs.length > 0 && <span className="inline-flex items-center gap-0.5"><Zap className="size-2.5" />{rs.length}</span>}
                  {ai && <span className="inline-flex items-center gap-0.5 text-accent"><Sparkles className="size-2.5" />IA</span>}
                  {!!s.policy?.approvals && <span className="inline-flex items-center gap-0.5 text-emerald-400"><UserCheck className="size-2.5" />{s.policy.approvals}</span>}
                  {locked && <Lock className="size-2.5" />}
                  {s.parallel && <span>paralela</span>}
                  {s.system && <span className="ml-auto">sistema</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {layout.loose.length > 0 && (
        <p className="text-xs text-mute">
          Também movem issues, de qualquer etapa: {layout.loose.map((r) => `${r.name || 'regra'} → ${stages.find((s) => s.id === r.config.to)?.name}`).join(' · ')}
        </p>
      )}
    </div>
  );
}
