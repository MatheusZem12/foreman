import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Lock, Sparkles, UserCheck, Zap } from 'lucide-react';
import { StatusIcon, Toggle } from '../components/ui';
import { PRIORITIES, stageGroups } from '../lib/constants';
import type { Rule, Stage } from '../lib/types';

// Mapa do fluxo: as etapas de cima para baixo (as em paralelo lado a lado
// na mesma linha) e uma seta para cada caminho possível — a ordem
// do quadro, as regras de mover (com a condição), as aprovações e, se quiser,
// o que o sistema faz sozinho (agente começa, IA concluiu, falhou…).

type Kind = 'seq' | 'rule' | 'approve' | 'system';
interface Edge { from: string; to: string; kind: Kind; label: string }

const W = 176, H = 50, GX = 28, GY = 58, PAD = 16, START_W = 112;
const COLORS: Record<Kind, string> = { seq: 'rgb(255 255 255 / 0.22)', rule: '#9d8cff', approve: '#34d399', system: '#f5b83d' };
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

export function FlowMap({ stages, rules }: { stages: Stage[]; rules: Rule[] }) {
  const [system, setSystem] = useState(true);
  const map = useMemo(() => {
    const ids = new Set(stages.map((s) => s.id));
    const edges: Edge[] = [];
    // Regras que movem, a partir da etapa do gatilho; "issue criada" sai do início.
    const loose: Rule[] = [];
    for (const r of rules) {
      if (!r.enabled || r.action !== 'move' || !r.config?.to || !ids.has(r.config.to)) continue;
      if (['enter', 'leave', 'stale'].includes(r.trigger) && ids.has(r.stage)) edges.push({ from: r.stage, to: r.config.to, kind: 'rule', label: condLabel(r) });
      else if (r.trigger === 'created') edges.push({ from: START, to: r.config.to, kind: 'rule', label: condLabel(r) === 'sempre' ? 'issue criada' : condLabel(r) });
      else loose.push(r);
    }
    for (const s of stages) {
      const p = s.policy;
      if (p?.approvals) {
        const to = p.approveTo || 'done';
        if (ids.has(to)) edges.push({ from: s.id, to, kind: 'approve', label: `✓ ${p.approvals} aprovação${p.approvals > 1 ? 'ões' : ''}` });
      }
    }
    if (system) edges.push(...SYSTEM_EDGES.filter((e) => ids.has(e.from) && ids.has(e.to)));
    // Cancelada só aparece se algo leva até ela.
    const visible = stages.filter((s) => s.id !== 'cancelled' || edges.some((e) => e.to === 'cancelled' || e.from === 'cancelled'));
    const groups = stageGroups(visible);
    // A ordem do quadro liga cada degrau ao próximo (tracejado), sem repetir um caminho já desenhado.
    const has = (a: string, b: string) => edges.some((e) => e.from === a && e.to === b);
    const seq: Edge[] = [];
    if (groups[0]) for (const t of groups[0]) if (!has(START, t.id)) seq.push({ from: START, to: t.id, kind: 'seq', label: '' });
    for (let i = 0; i + 1 < groups.length; i++)
      for (const a of groups[i]) for (const b of groups[i + 1]) if (!has(a.id, b.id)) seq.push({ from: a.id, to: b.id, kind: 'seq', label: '' });
    return { groups, edges: [...seq, ...edges], loose };
  }, [stages, rules, system]);

  // Layout vertical: cada degrau é uma linha (de cima para baixo) e as etapas
  // em paralelo ficam lado a lado na mesma linha.
  const cols = Math.max(1, ...map.groups.map((g) => g.length));
  const sideLanes = Math.min(8, map.edges.filter((e) => e.kind !== 'seq').length);
  const side = 56 + sideLanes * 16;
  const inner = cols * W + (cols - 1) * GX;
  const width = side * 2 + inner;
  const rowY = (r: number) => PAD + (r + 1) * (H + GY);
  const height = rowY(map.groups.length - 1) + H + PAD;
  const pos = new Map<string, { x: number; y: number; row: number }>();
  map.groups.forEach((g, r) => {
    const rowW = g.length * W + (g.length - 1) * GX;
    g.forEach((s, c) => pos.set(s.id, { x: side + (inner - rowW) / 2 + c * (W + GX), y: rowY(r), row: r }));
  });
  pos.set(START, { x: side + (inner - START_W) / 2, y: PAD, row: -1 });
  const wOf = (id: string) => (id === START ? START_W : W);

  // Rotas: próxima linha = curva direta; pulando linhas = arco pela direita;
  // voltando ou na mesma linha = arco pela esquerda. Cada arco tem a sua faixa.
  let right = 0, left = 0;
  const paths = map.edges.map((e, i) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b || e.from === e.to) return null;
    const ax = a.x + wOf(e.from) / 2, bx = b.x + W / 2;
    let d: string, lx: number, ly: number;
    if (b.row === a.row + 1) {
      const y1 = a.y + H, y2 = b.y;
      d = `M${ax},${y1} C${ax},${y1 + GY / 2} ${bx},${y2 - GY / 2} ${bx},${y2 - 6}`;
      // Rótulo perto do destino: numa bifurcação, cada um fica sobre o seu ramo.
      lx = ax + (bx - ax) * 0.82; ly = y1 + (y2 - y1) * 0.62;
    } else if (b.row > a.row && ax >= side + inner / 2) {
      const lane = right++ % 8;
      const x1 = a.x + wOf(e.from), x2 = b.x + W, cx = side + inner + 24 + lane * 16;
      const y1 = a.y + H / 2, y2 = b.y + H / 2;
      d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2 + 6},${y2}`;
      lx = cx - 14; ly = (y1 + y2) / 2;
    } else {
      // Para trás, na mesma linha, ou pulando linhas a partir do lado esquerdo: contorna pela esquerda.
      const lane = left++ % 8;
      const x1 = a.x, x2 = b.x, cx = side - 24 - lane * 16;
      const y1 = a.y + H / 2, y2 = b.y + H / 2;
      d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2 - 6},${y2}`;
      lx = cx + 14; ly = (y1 + y2) / 2;
    }
    return { e, d, lx, ly, key: i };
  }).filter(Boolean) as { e: Edge; d: string; lx: number; ly: number; key: number }[];

  const stageRules = (id: string) => rules.filter((r) => r.stage === id && r.enabled);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-mute">
        {([['seq', 'ordem do quadro'], ['rule', 'regra de mover'], ['approve', 'aprovação'], ['system', 'automático do sistema']] as [Kind, string][]).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={COLORS[k]} strokeWidth="2" strokeDasharray={k === 'seq' || k === 'system' ? '4 3' : undefined} /></svg>{label}
          </span>
        ))}
        <span className="ml-auto"><Toggle checked={system} onChange={setSystem} label="Mostrar o que o sistema faz sozinho" /></span>
      </div>
      <div className="surface overflow-auto">
        <div className="relative mx-auto" style={{ width, height }}>
          <svg className="absolute inset-0" width={width} height={height}>
            <defs>
              {(Object.keys(COLORS) as Kind[]).map((k) => (
                <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={COLORS[k]} />
                </marker>
              ))}
            </defs>
            {paths.map(({ e, d, key }) => (
              <path key={key} d={d} fill="none" stroke={COLORS[e.kind]} strokeWidth={e.kind === 'seq' ? 1.5 : 2}
                strokeDasharray={e.kind === 'seq' || e.kind === 'system' ? '5 4' : undefined} markerEnd={`url(#arrow-${e.kind})`} opacity={e.kind === 'system' ? 0.75 : 1} />
            ))}
          </svg>
          {paths.filter((p) => p.e.label).map(({ e, lx, ly, key }) => (
            <span key={`l${key}`} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border px-1.5 py-px text-[10px] font-medium"
              style={{ left: lx, top: ly, color: COLORS[e.kind], borderColor: `${COLORS[e.kind]}55`, background: 'rgb(var(--panel))' }}>
              {e.label}
            </span>
          ))}
          <div className="absolute flex items-center justify-center rounded-full border border-dashed border-white/20 text-[12px] text-dim"
            style={{ left: pos.get(START)!.x, top: pos.get(START)!.y + 8, width: START_W, height: H - 16 }}>Nova issue</div>
          {map.groups.flat().map((s) => {
            const p = pos.get(s.id)!;
            const rs = stageRules(s.id);
            const ai = rs.some((r) => r.action === 'run_agent');
            const locked = !!(s.policy?.act?.roles?.length || s.policy?.act?.users?.length || s.policy?.readOnly);
            return (
              <div key={s.id} title={rs.length ? `${rs.length} regra(s) nesta etapa` : undefined}
                className={clsx('absolute flex flex-col justify-center rounded-xl border bg-card px-3 shadow-[0_6px_20px_-12px_rgb(0_0_0/0.9)]', s.parallel ? 'border-white/15' : 'border-white/10')}
                style={{ left: p.x, top: p.y, width: W, height: H, boxShadow: `inset 3px 0 0 0 ${s.color}` }}>
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
      {map.loose.length > 0 && (
        <p className="text-xs text-mute">
          Também movem issues, de qualquer etapa: {map.loose.map((r) => `${r.name || 'regra'} → ${stages.find((s) => s.id === r.config.to)?.name}`).join(' · ')}
        </p>
      )}
    </div>
  );
}
