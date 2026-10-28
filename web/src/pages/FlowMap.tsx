import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Lock, Sparkles, UserCheck, Zap } from 'lucide-react';
import { StatusIcon, Toggle } from '../components/ui';
import { PRIORITIES, stageGroups } from '../lib/constants';
import type { Rule, Stage } from '../lib/types';
import { t } from '../lib/i18n';

// Mapa do fluxo em grade, de cima para baixo. As etapas ficam numa coluna
// central na ordem do quadro (paralelas lado a lado na mesma linha). Seta entre
// linhas vizinhas desce reta pelo meio; qualquer outra (pular etapa, voltar)
// sai pela lateral e corre num corredor próprio: à direita quem desce, à
// esquerda quem sobe. Só linhas retas e cantos arredondados.

type Kind = 'seq' | 'rule' | 'approve' | 'system';
interface Edge { from: string; to: string; kind: Kind; label: string }
interface Pt { x: number; y: number }
interface Box { id: string; x: number; y: number; w: number; h: number; row: number; col: number; n: number }
interface Pill { x: number; y: number; w: number }
type Face = 'L' | 'R' | 'T' | 'B';

const NODE_W = 180, NODE_H = 52, START_W = 124, START_H = 34;
const COL_GAP = 28, ROW_GAP = 64, LANE_PAD = 36, LANE_GAP = 26, PILL_H = 20, MARGIN = 20;
const COLORS: Record<Kind, string> = { seq: 'rgb(var(--ink) / 0.22)', rule: '#9d8cff', approve: '#34d399', system: '#e0a43a' };
const START = '__start';

const SYSTEM_EDGES: Edge[] = [
  { from: 'todo', to: 'in_progress', kind: 'system', label: t('agente começa') },
  { from: 'in_progress', to: 'in_review', kind: 'system', label: t('IA concluiu') },
  { from: 'in_progress', to: 'waiting', kind: 'system', label: t('IA precisa de você') },
  { from: 'in_progress', to: 'blocked', kind: 'system', label: t('falhou') },
  { from: 'waiting', to: 'in_progress', kind: 'system', label: t('você respondeu') }
];

function condLabel(r: Rule) {
  const c = r.conditions ?? {};
  const parts: string[] = [];
  if (r.trigger === 'leave') parts.push(t('ao sair'));
  if (r.trigger === 'stale') parts.push(t('parada {0}h', c.hours ?? '?'));
  if (c.priorities?.length) parts.push(c.priorities.map((p) => PRIORITIES.find((x) => x.id === p)?.label).join('/'));
  if (c.labels?.length) parts.push(t('{0} label(s)', c.labels.length));
  if (c.agents?.length) parts.push(t('por agente'));
  if (c.actorRoles?.length) parts.push(t('por perfil'));
  return parts.join(' · ') || t('sempre');
}

const pillW = (text: string) => text.length * 6.1 + 18;

// Linha ortogonal com cantos arredondados.
function rounded(raw: Pt[], r = 8) {
  const p = raw.filter((q, i) => i === 0 || q.x !== raw[i - 1].x || q.y !== raw[i - 1].y);
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const d1 = Math.hypot(b.x - a.x, b.y - a.y), d2 = Math.hypot(c.x - b.x, c.y - b.y);
    const k = Math.min(r, d1 / 2, d2 / 2);
    d += ` L${b.x + ((a.x - b.x) / d1) * k},${b.y + ((a.y - b.y) / d1) * k}`;
    d += ` Q${b.x},${b.y} ${b.x + ((c.x - b.x) / d2) * k},${b.y + ((c.y - b.y) / d2) * k}`;
  }
  const l = p[p.length - 1];
  return `${d} L${l.x},${l.y}`;
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
      else if (r.trigger === 'created') edges.push({ from: START, to: r.config.to, kind: 'rule', label: condLabel(r) === t('sempre') ? t('issue criada') : condLabel(r) });
      else loose.push(r);
    }
    for (const s of stages) {
      const p = s.policy;
      if (p?.approvals && ids.has(p.approveTo || 'done')) {
        edges.push({ from: s.id, to: p.approveTo || 'done', kind: 'approve', label: p.approvals > 1 ? t('✓ {0} aprovações', p.approvals) : t('✓ {0} aprovação', p.approvals) });
      }
    }
    if (system) edges.push(...SYSTEM_EDGES.filter((e) => ids.has(e.from) && ids.has(e.to)));
    const visible = stages.filter((s) => s.id !== 'cancelled' || edges.some((e) => e.to === 'cancelled' || e.from === 'cancelled'));
    const groups = stageGroups(visible);

    // Grade: uma linha por degrau do quadro, centralizada em x = 0.
    const rows = [[START], ...groups.map((g) => g.map((s) => s.id))];
    const box = new Map<string, Box>();
    let top = 0;
    rows.forEach((row, r) => {
      const h = r === 0 ? START_H : NODE_H;
      const w = r === 0 ? START_W : NODE_W;
      let x = -(row.length * w + (row.length - 1) * COL_GAP) / 2;
      row.forEach((id, col) => {
        box.set(id, { id, x, y: top, w, h, row: r, col, n: row.length });
        x += w + COL_GAP;
      });
      top += h + ROW_GAP;
    });
    const half = Math.max(...[...box.values()].map((b) => Math.max(-b.x, b.x + b.w)));
    const cx = (b: Box) => b.x + b.w / 2;

    // Ordem do quadro: liga cada degrau ao próximo, quando nada mais liga.
    const has = (a: string, b: string) => edges.some((e) => e.from === a && e.to === b);
    const seq: Edge[] = [];
    for (let i = 0; i + 1 < rows.length; i++)
      for (const a of rows[i]) for (const b of rows[i + 1]) if (!has(a, b)) seq.push({ from: a, to: b, kind: 'seq', label: '' });

    const all = [...seq, ...edges].filter((e) => box.has(e.from) && box.has(e.to) && e.from !== e.to);
    // seg: trecho vertical onde o rótulo pode ficar.
    type Seg = { x: number; y1: number; y2: number };
    const out: { e: Edge; pts: Pt[]; pill?: Pill; segs: Seg[] }[] = [];
    const lanes: { e: Edge; a: Box; b: Box; side: 'L' | 'R'; lo: number; hi: number; k: number }[] = [];
    const used = new Set<string>();

    for (const e of all) {
      const a = box.get(e.from)!, b = box.get(e.to)!;
      const key = `${e.from}>${e.to}`;
      if (b.row === a.row + 1 && !used.has(key)) {
        // Vizinhos: desce reto (ou em "garfo" quando há paralelas).
        used.add(key);
        const s = { x: cx(a), y: a.y + a.h }, tt = { x: cx(b), y: b.y }, mid = s.y + ROW_GAP / 2;
        const pts = s.x === tt.x ? [s, tt] : [s, { x: s.x, y: mid }, { x: tt.x, y: mid }, tt];
        const up = { x: s.x, y1: s.y, y2: mid }, down = { x: tt.x, y1: mid, y2: tt.y };
        out.push({ e, pts, segs: s.x === tt.x ? [{ x: s.x, y1: s.y, y2: tt.y }] : b.n > 1 ? [down, up] : [up, down] });
      } else {
        const side = b.row > a.row || b.row === a.row ? 'R' : 'L';
        lanes.push({ e, a, b, side, lo: Math.min(a.row, b.row), hi: Math.max(a.row, b.row), k: 0 });
      }
    }

    // Corredores: trechos curtos ficam mais perto das etapas; dois trechos que
    // se sobrepõem na vertical nunca dividem o mesmo corredor.
    for (const side of ['L', 'R'] as const) {
      const taken: { lo: number; hi: number; k: number }[] = [];
      for (const l of lanes.filter((x) => x.side === side).sort((p, q) => p.hi - p.lo - (q.hi - q.lo) || p.lo - q.lo)) {
        let k = 0;
        while (taken.some((tt) => tt.k === k && !(tt.hi < l.lo || l.hi < tt.lo))) k++;
        l.k = k;
        taken.push({ lo: l.lo, hi: l.hi, k });
      }
    }

    // Pontos de encaixe: lateral para a etapa da ponta da linha; quem está no
    // meio de uma linha de paralelas sai por baixo/cima para não cruzar a vizinha.
    const faceOf = (n: Box, side: 'L' | 'R', down: boolean, leaving: boolean): Face => {
      const edge = side === 'R' ? n.col === n.n - 1 : n.col === 0;
      if (edge) return side;
      return leaving ? (down ? 'B' : 'T') : (down ? 'T' : 'B');
    };
    const slots = new Map<string, number>();
    const take = (id: string, f: Face) => { const k = `${id}:${f}`; const i = slots.get(k) ?? 0; slots.set(k, i + 1); return i; };
    const count = new Map<string, number>();
    const plan = lanes.map((l) => {
      const down = l.b.row >= l.a.row;
      const fa = faceOf(l.a, l.side, down, true), fb = faceOf(l.b, l.side, down, false);
      count.set(`${l.a.id}:${fa}`, (count.get(`${l.a.id}:${fa}`) ?? 0) + 1);
      count.set(`${l.b.id}:${fb}`, (count.get(`${l.b.id}:${fb}`) ?? 0) + 1);
      return { l, fa, fb };
    });
    // Saídas na ordem do corredor (o mais perto em cima) para não se cruzarem.
    plan.sort((p, q) => p.l.k - q.l.k);
    const port = (n: Box, f: Face, side: 'L' | 'R') => {
      const i = take(n.id, f), total = count.get(`${n.id}:${f}`) ?? 1;
      if (f === 'L' || f === 'R') {
        const step = Math.min(12, (n.h - 18) / Math.max(total - 1, 1));
        return { p: { x: f === 'R' ? n.x + n.w : n.x, y: n.y + n.h / 2 + (i - (total - 1) / 2) * step }, i };
      }
      const dir = side === 'R' ? 1 : -1;
      return { p: { x: cx(n) + dir * (22 + i * 14), y: f === 'B' ? n.y + n.h : n.y }, i };
    };
    for (const { l, fa, fb } of plan) {
      const laneX = (l.side === 'R' ? 1 : -1) * (half + LANE_PAD + l.k * LANE_GAP);
      const s = port(l.a, fa, l.side), tt = port(l.b, fb, l.side);
      const gap = (f: Face, n: Box, i: number) => (f === 'B' ? n.y + n.h + 14 + i * 6 : n.y - 14 - i * 6);
      const head: Pt[] = fa === 'L' || fa === 'R' ? [s.p, { x: laneX, y: s.p.y }]
        : [s.p, { x: s.p.x, y: gap(fa, l.a, s.i) }, { x: laneX, y: gap(fa, l.a, s.i) }];
      const tail: Pt[] = fb === 'L' || fb === 'R' ? [{ x: laneX, y: tt.p.y }, tt.p]
        : [{ x: laneX, y: gap(fb, l.b, tt.i) }, { x: tt.p.x, y: gap(fb, l.b, tt.i) }, tt.p];
      const y1 = head[head.length - 1].y, y2 = tail[0].y;
      out.push({ e: l.e, pts: [...head, ...tail], segs: [{ x: laneX, y1: Math.min(y1, y2), y2: Math.max(y1, y2) }] });
    }

    // Rótulos: no meio do trecho; se bater em etapa, outro rótulo ou linha de
    // outra seta, desliza pelo próprio trecho até achar espaço. Encostar numa
    // linha vertical vizinha ou na ordem do quadro é o último recurso.
    type R = { x: number; y: number; w: number; h: number };
    const overlap = (r: R, o: R) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
    const boxes: R[] = [...box.values()].map((b) => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }));
    const lines = out.flatMap((o, i) => o.pts.slice(1).map((q, j) => {
      const p = o.pts[j];
      return { i, soft: p.x === q.x || o.e.kind === 'seq', r: { x: Math.min(p.x, q.x) - 2, y: Math.min(p.y, q.y) - 2, w: Math.abs(q.x - p.x) + 4, h: Math.abs(q.y - p.y) + 4 } };
    }));
    const placed: R[] = [];
    const rect = (p: Pill): R => ({ x: p.x - p.w / 2 - 3, y: p.y - PILL_H / 2 - 3, w: p.w + 6, h: PILL_H + 6 });
    out.forEach((o, i) => {
      if (!o.e.label) return;
      const w = pillW(o.e.label);
      const free = (p: Pill, strict: boolean) => {
        const r = rect(p);
        return ![...boxes, ...placed].some((q) => overlap(r, q)) && !lines.some((l) => l.i !== i && (strict || !l.soft) && overlap(r, l.r));
      };
      const fits = o.segs.flatMap(({ x, y1, y2 }) => {
        const mid = (y1 + y2) / 2, c: Pill[] = [];
        for (let d = 0; d <= (y2 - y1) / 2; d += 6) c.push({ x, y: mid + d, w }, { x, y: mid - d, w });
        return c.filter((p) => p.y - PILL_H / 2 >= y1 - 2 && p.y + PILL_H / 2 <= y2 + 2);
      });
      const first = o.segs[0];
      o.pill = fits.find((p) => free(p, true)) ?? fits.find((p) => free(p, false)) ?? { x: first.x, y: (first.y1 + first.y2) / 2, w };
      placed.push(rect(o.pill));
    });

    // Moldura: tudo que foi desenhado, com margem.
    const xs = [...[...box.values()].flatMap((b) => [b.x, b.x + b.w]), ...out.flatMap((o) => o.pts.map((p) => p.x)), ...out.flatMap((o) => (o.pill ? [o.pill.x - o.pill.w / 2, o.pill.x + o.pill.w / 2] : []))];
    const ys = [...[...box.values()].flatMap((b) => [b.y, b.y + b.h]), ...out.flatMap((o) => o.pts.map((p) => p.y))];
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return {
      edges: out, boxes: [...box.values()], loose,
      ox: MARGIN - minX, oy: MARGIN - minY,
      width: Math.max(...xs) - minX + MARGIN * 2, height: Math.max(...ys) - minY + MARGIN * 2
    };
  }, [stages, rules, system]);

  const byId = new Map(stages.map((s) => [s.id, s]));
  const stageRules = (id: string) => rules.filter((r) => r.stage === id && r.enabled);
  const shown = layout.edges.filter(({ e }) => e.kind !== 'seq' || showSeq);
  const { ox, oy } = layout;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-mute">
        {([['seq', t('ordem do quadro')], ['rule', t('regra de mover')], ['approve', t('aprovação')], ['system', t('automático do sistema')]] as [Kind, string][]).map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" style={{ stroke: k === 'seq' ? 'rgb(var(--ink) / 0.4)' : COLORS[k] }} strokeWidth="2" strokeDasharray={k === 'seq' ? '2 3' : k === 'system' ? '5 3' : undefined} /></svg>{label}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-4">
          <Toggle checked={showSeq} onChange={setShowSeq} label={t('Ordem do quadro')} />
          <Toggle checked={system} onChange={setSystem} label={t('O que o sistema faz sozinho')} />
        </span>
      </div>
      <div className="surface overflow-auto">
        <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
          <svg className="absolute inset-0" width={layout.width} height={layout.height}>
            <defs>
              {(Object.keys(COLORS) as Kind[]).map((k) => (
                <marker key={k} id={`fm-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M1,1.5 L9,5 L1,8.5 Z" style={{ fill: k === 'seq' ? 'rgb(var(--ink) / 0.35)' : COLORS[k] }} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${ox},${oy})`}>
              {/* Ordem do quadro por baixo, o resto por cima. */}
              {[...shown].sort((a, b) => Number(b.e.kind === 'seq') - Number(a.e.kind === 'seq')).map(({ e, pts }, i) => (
                <path key={i} d={rounded(pts)} fill="none" style={{ stroke: COLORS[e.kind] }}
                  strokeWidth={e.kind === 'seq' ? 1.25 : 1.6} strokeLinecap="round" strokeLinejoin="round"
                  strokeDasharray={e.kind === 'seq' ? '2 4' : e.kind === 'system' ? '5 4' : undefined}
                  markerEnd={`url(#fm-${e.kind})`} />
              ))}
            </g>
          </svg>
          {shown.filter(({ pill }) => pill).map(({ e, pill }, i) => (
            <span key={`l${i}`} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-2 text-[10px] font-medium leading-[18px]"
              style={{ left: pill!.x + ox, top: pill!.y + oy, color: COLORS[e.kind], borderColor: `${COLORS[e.kind]}55`, background: 'rgb(var(--panel))' }}>
              {e.label}
            </span>
          ))}
          {layout.boxes.map((n) => {
            const style = { left: n.x + ox, top: n.y + oy, width: n.w, height: n.h };
            if (n.id === START) {
              return <div key={n.id} className="absolute flex items-center justify-center rounded-full border border-dashed border-white/25 bg-panel text-[12px] text-dim" style={style}>{t('Nova issue')}</div>;
            }
            const s = byId.get(n.id)!;
            const rs = stageRules(s.id);
            const ai = rs.some((r) => r.action === 'run_agent');
            const locked = !!(s.policy?.act?.roles?.length || s.policy?.act?.users?.length || s.policy?.readOnly);
            return (
              <div key={n.id} title={rs.length ? t('{0} regra(s) nesta etapa', rs.length) : undefined}
                className={clsx('absolute flex flex-col justify-center rounded-xl border bg-card px-3 shadow-[0_8px_24px_-14px_rgb(0_0_0/0.9)]', s.parallel ? 'border-white/15' : 'border-white/[0.09]')}
                style={{ ...style, boxShadow: `inset 3px 0 0 0 ${s.color}` }}>
                <div className="flex items-center gap-1.5 text-[13px] font-medium"><StatusIcon status={s.id} /><span className="truncate">{s.name}</span></div>
                <div className="mt-0.5 flex h-3.5 items-center gap-2 text-[10px] text-mute">
                  {rs.length > 0 && <span className="inline-flex items-center gap-0.5"><Zap className="size-2.5" />{rs.length}</span>}
                  {ai && <span className="inline-flex items-center gap-0.5 text-accent"><Sparkles className="size-2.5" />{t('IA')}</span>}
                  {!!s.policy?.approvals && <span className="inline-flex items-center gap-0.5 text-emerald-400"><UserCheck className="size-2.5" />{s.policy.approvals}</span>}
                  {locked && <Lock className="size-2.5" />}
                  {s.parallel && <span>{t('paralela')}</span>}
                  {s.system && <span className="ml-auto">{t('sistema')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {layout.loose.length > 0 && (
        <p className="text-xs text-mute">
          {t('Também movem issues, de qualquer etapa:')} {layout.loose.map((r) => `${t('regra')} → ${stages.find((s) => s.id === r.config.to)?.name}`).join(' · ')}
        </p>
      )}
    </div>
  );
}
