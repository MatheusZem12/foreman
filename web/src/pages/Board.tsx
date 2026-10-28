import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from '@dnd-kit/core';
import clsx from 'clsx';
import { Columns3, List, ListFilter, Plus, Search } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Chip, MenuItem, Popover, PriorityIcon, Spinner, StatusIcon, useToast } from '../components/ui';
import { LabelDots } from '../components/pickers';
import { STATUSES, stageGroups, statusOf } from '../lib/constants';
import { useAgents, useIssues, useLabels, useMe, useStages } from '../lib/queries';
import { money, timeAgo } from '../lib/format';
import { api } from '../lib/api';
import type { Agent, Issue, Label, Status } from '../lib/types';
import { AgentIcon } from '../components/AgentIcon';
import { t } from '../lib/i18n';

type Sort = 'manual' | 'priority' | 'updated';

// Marca o fim de um arraste: o clique que vem logo depois não deve abrir a issue.
let lastDragEnd = 0;
type View = 'board' | 'list';

function readPref<T extends string>(key: string, def: T): T {
  try {
    return (localStorage.getItem(key) as T) || def;
  } catch {
    return def;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* sem storage */
  }
}

// A exibição do quadro é de cada pessoa, por workspace (lado a lado ou em
// grade). A ORDEM das colunas vem só do fluxo: muda em Fluxo e automações.
type BoardLayout = { mode: 'side' | 'grid'; perRow: number };
const DEFAULT_LAYOUT: BoardLayout = { mode: 'side', perRow: 3 };

function useBoardLayout(wsId: string) {
  const qc = useQueryClient();
  const key = ['pref', `board:${wsId}`];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<Partial<BoardLayout>>(`/me/prefs/board:${wsId}`),
    staleTime: Infinity
  });
  const layout: BoardLayout = { ...DEFAULT_LAYOUT, ...data };
  const save = (patch: Partial<BoardLayout>) => {
    const next = { ...layout, ...patch };
    qc.setQueryData(key, next);
    api.put(`/me/prefs/board:${wsId}`, next).catch(() => { /* fica só nesta sessão */ });
  };
  return [layout, save] as const;
}

// No modo lado a lado: a roda do mouse anda para os lados (a menos que esteja
// sobre uma lista que rola na vertical) e arrastar o fundo também.
function useSideScroll(el: HTMLDivElement | null) {
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      const body = (e.target as HTMLElement).closest<HTMLElement>('[data-col-body]');
      if (body && body.scrollHeight > body.clientHeight) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    let start: { x: number; left: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if ((e.target as HTMLElement).closest('a,button,input,[data-col-head]')) return;
      start = { x: e.clientX, left: el.scrollLeft };
      e.preventDefault(); // não selecionar texto enquanto arrasta
    };
    const onMove = (e: PointerEvent) => {
      if (!start) return;
      el.scrollLeft = start.left - (e.clientX - start.x);
      el.style.cursor = 'grabbing';
    };
    const onUp = () => {
      start = null;
      el.style.cursor = '';
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [el]);
}

function sortIssues(list: Issue[], sort: Sort) {
  const copy = list.slice();
  if (sort === 'priority') copy.sort((a, b) => (a.priority || 9) - (b.priority || 9) || a.position - b.position);
  else if (sort === 'updated') copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  else copy.sort((a, b) => a.position - b.position || b.number - a.number);
  return copy;
}

export function Board() {
  const { ws, openNewIssue } = useWs();
  const { data: issues, isLoading } = useIssues(ws.id);
  const { data: agents = [] } = useAgents();
  const { data: labels = [] } = useLabels(ws.id);
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();

  const [view, setView] = useState<View>(() => readPref('mx.view', 'board'));
  const [sort, setSort] = useState<Sort>(() => readPref('mx.sort', 'manual'));
  const [who, setWho] = useState<'all' | 'mine' | string>('all');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [dragging, setDragging] = useState<Issue | null>(null);
  const [layout, saveLayout] = useBoardLayout(ws.id);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useSideScroll(layout.mode === 'side' ? scroller : null);

  const filtered = useMemo(() => {
    const tt = text.trim().toLowerCase();
    return (issues ?? []).filter((i) => {
      if (who === 'mine' && i.createdBy !== me?.id) return false;
      if (who !== 'all' && who !== 'mine' && i.agentId !== who) return false;
      if (labelFilter && !i.labelIds.includes(labelFilter)) return false;
      if (tt && !`${ws.key}-${i.number} ${i.title}`.toLowerCase().includes(tt)) return false;
      return true;
    });
  }, [issues, who, labelFilter, text, me, ws.key]);

  const { data: stages } = useStages(ws.id);
  const byStatus = useMemo(() => {
    const map = {} as Record<Status, Issue[]>;
    for (const s of STATUSES) map[s.id] = [];
    for (const i of filtered) (map[i.status] ??= []).push(i);
    for (const s of STATUSES) map[s.id] = sortIssues(map[s.id], sort);
    return map;
  }, [filtered, sort, stages]); // eslint-disable-line react-hooks/exhaustive-deps

  const working = (issues ?? []).filter((i) => i.activeRun).length;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } })
  );

  const move = async (issue: Issue, status: Status, position: number) => {
    const key = ['issues', ws.id];
    const prev = qc.getQueryData<Issue[]>(key);
    qc.setQueryData<Issue[]>(key, (l) => l?.map((i) => (i.id === issue.id ? { ...i, status, position } : i)));
    try {
      const res = await api.patch<{ issue: Issue; warning?: string }>(`/issues/${issue.id}`, { status, position });
      if (res.warning) toast('error', res.warning);
    } catch (err) {
      qc.setQueryData(key, prev);
      toast('error', (err as Error).message);
    }
  };

  const onDragStart = (e: DragStartEvent) => setDragging((issues ?? []).find((i) => i.id === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    lastDragEnd = Date.now();
    const issue = (issues ?? []).find((i) => i.id === e.active.id);
    const overId = String(e.over?.id ?? '');
    if (!issue || !overId) return;
    let status: Status;
    let list: Issue[];
    let index: number;
    if (overId.startsWith('col:')) {
      status = overId.slice(4) as Status;
      list = byStatus[status].filter((i) => i.id !== issue.id);
      index = list.length;
    } else {
      const over = (issues ?? []).find((i) => i.id === overId.slice(5));
      if (!over || over.id === issue.id) return;
      status = over.status;
      list = byStatus[status].filter((i) => i.id !== issue.id);
      index = list.findIndex((i) => i.id === over.id);
    }
    // Posição entre os vizinhos: um único UPDATE, sem renumerar a coluna.
    const before = list[index - 1]?.position;
    const after = list[index]?.position;
    const position =
      before === undefined && after === undefined ? 0 : before === undefined ? after! - 1024 : after === undefined ? before + 1024 : (before + after) / 2;
    if (status === issue.status && position === issue.position) return;
    if (sort !== 'manual' && status === issue.status) return; // reordenar só vale na ordem manual
    move(issue, status, position);
  };

  // Etapas que encerram como cancelada ficam escondidas, a não ser que a pessoa peça.
  const columns = STATUSES.filter((s) => s.closes !== 'cancelled' || showCancelled).map((s) => s.id);
  // Etapas em paralelo dividem a mesma coluna, uma embaixo da outra.
  const groups = stageGroups(STATUSES.filter((s) => columns.includes(s.id))).map((g) => g.map((s) => s.id));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line/70 bg-panel/40 px-3 py-2.5 backdrop-blur md:px-5">
        <h1 className="mr-2 hidden text-[15px] font-semibold tracking-tight md:block">{t('Issues')}</h1>
        <div className="flex rounded-lg border border-line bg-white/[0.02] p-0.5">
          {[
            ['all', t('Todas')],
            ['mine', t('Minhas')]
          ].map(([id, label]) => (
            <button key={id} onClick={() => setWho(id)} className={clsx('rounded-md px-2.5 py-1 text-xs transition', who === id ? 'bg-white/10 text-fg' : 'text-mute hover:text-fg')}>{label}</button>
          ))}
          <AgentFilter agents={agents} value={who} onChange={setWho} />
        </div>
        <div className="relative hidden sm:block">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Filtrar…')} className="field-input h-8 w-52 py-1 pl-8" />
        </div>
        <LabelFilter labels={labels} value={labelFilter} onChange={setLabelFilter} />
        <div className="ml-auto flex items-center gap-1.5">
          <span className={clsx('hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs sm:flex', working ? 'text-amber-400' : 'text-mute')}>
            <span className={clsx('size-1.5 rounded-full', working ? 'animate-pulse-soft bg-amber-400' : 'bg-mute')} /> {working} {working === 1 ? t('agente trabalhando') : t('agentes trabalhando')}
          </span>
          <Popover
            align="right"
            trigger={() => <Chip><ListFilter className="size-3.5" /> <span className="hidden sm:inline">{t('Exibir')}</span></Chip>}
          >
            {(close) => (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] text-mute">{t('Ordenar')}</div>
                {(
                  [
                    ['manual', t('Manual (arrastar)')],
                    ['priority', t('Prioridade')],
                    ['updated', t('Atualização')]
                  ] as [Sort, string][]
                ).map(([id, label]) => (
                  <MenuItem key={id} selected={sort === id} onClick={() => { setSort(id); writePref('mx.sort', id); close(); }}>{label}</MenuItem>
                ))}
                <div className="my-1 border-t border-line" />
                <MenuItem selected={showCancelled} onClick={() => setShowCancelled(!showCancelled)}>{t('Mostrar canceladas')}</MenuItem>
                <div className="my-1 border-t border-line" />
                <div className="px-2 pb-1 pt-1 text-[11px] text-mute">{t('Colunas (só para você)')}</div>
                <MenuItem selected={layout.mode === 'side'} onClick={() => saveLayout({ mode: 'side' })}>{t('Lado a lado')}</MenuItem>
                <MenuItem selected={layout.mode === 'grid'} onClick={() => saveLayout({ mode: 'grid' })}>{t('Uma embaixo da outra')}</MenuItem>
                {layout.mode === 'grid' && (
                  <div className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-mute">
                    {t('Por linha')}
                    {[1, 2, 3, 4].map((n) => (
                      <button key={n} onClick={() => saveLayout({ perRow: n })} className={clsx('ml-1 rounded-md px-2 py-0.5', layout.perRow === n ? 'bg-white/10 text-fg' : 'hover:text-fg')}>{n}</button>
                    ))}
                  </div>
                )}
                <div className="px-2.5 pb-1 pt-0.5 text-[11px] leading-snug text-mute">{t('A ordem das colunas segue o fluxo (Fluxo e automações).')}</div>
              </>
            )}
          </Popover>
          <div className="flex rounded-lg border border-line bg-white/[0.02] p-0.5">
            <button onClick={() => { setView('board'); writePref('mx.view', 'board'); }} className={clsx('rounded-md p-1.5', view === 'board' ? 'bg-white/10 text-fg' : 'text-mute')} title={t('Quadro')}><Columns3 className="size-3.5" /></button>
            <button onClick={() => { setView('list'); writePref('mx.view', 'list'); }} className={clsx('rounded-md p-1.5', view === 'list' ? 'bg-white/10 text-fg' : 'text-mute')} title={t('Lista')}><List className="size-3.5" /></button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid flex-1 place-items-center"><Spinner /></div>
      ) : view === 'list' ? (
        <ListView byStatus={byStatus} columns={columns} agents={agents} labels={labels} />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          {layout.mode === 'grid' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
              <div
                className="grid grid-cols-1 gap-3 sm:[grid-template-columns:repeat(var(--per-row),minmax(0,1fr))]"
                style={{ '--per-row': layout.perRow } as React.CSSProperties}
              >
                {groups.map((g) => g.length === 1
                  ? <Column key={g[0]} status={g[0]} grid issues={byStatus[g[0]]} agents={agents} labels={labels} onAdd={() => openNewIssue(g[0])} />
                  : (
                    <div key={g[0]} className="flex h-[clamp(20rem,60vh,40rem)] min-w-0 flex-col gap-2">
                      {g.map((s) => <Column key={s} status={s} stacked issues={byStatus[s]} agents={agents} labels={labels} onAdd={() => openNewIssue(s)} />)}
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <div ref={setScroller} className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 md:snap-none md:p-4">
              {groups.map((g) => g.length === 1
                ? <Column key={g[0]} status={g[0]} issues={byStatus[g[0]]} agents={agents} labels={labels} onAdd={() => openNewIssue(g[0])} />
                : (
                  <div key={g[0]} className="flex w-[85vw] shrink-0 snap-center flex-col gap-2 sm:w-[19rem]">
                    {g.map((s) => <Column key={s} status={s} stacked issues={byStatus[s]} agents={agents} labels={labels} onAdd={() => openNewIssue(s)} />)}
                  </div>
                ))}
            </div>
          )}
          <DragOverlay dropAnimation={null}>
            {dragging && <Tilt><Card issue={dragging} agents={agents} labels={labels} overlay /></Tilt>}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function AgentFilter({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (v: string) => void }) {
  const current = agents.find((a) => a.id === value);
  return (
    <Popover
      trigger={() => (
        <button className={clsx('rounded-md px-2.5 py-1 text-xs transition', current ? 'bg-white/10 text-fg' : 'text-mute hover:text-fg')}>{current ? <span className="inline-flex items-center gap-1.5"><AgentIcon avatar={current.avatar} size={14} />{current.name}</span> : t('Agentes')}</button>
      )}
    >
      {(close) =>
        agents.map((a) => (
          <MenuItem key={a.id} selected={a.id === value} onClick={() => { onChange(a.id === value ? 'all' : a.id); close(); }}>
            <AgentIcon avatar={a.avatar} /> {a.name}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

function LabelFilter({ labels, value, onChange }: { labels: Label[]; value: string | null; onChange: (v: string | null) => void }) {
  if (!labels.length) return null;
  const current = labels.find((l) => l.id === value);
  return (
    <Popover trigger={() => <Chip className={current ? 'text-fg' : ''}>{current ? <><span className="size-2 rounded-full" style={{ background: current.color }} />{current.name}</> : t('Label')}</Chip>}>
      {(close) => (
        <>
          <MenuItem selected={!value} onClick={() => { onChange(null); close(); }}>{t('Todas')}</MenuItem>
          {labels.map((l) => (
            <MenuItem key={l.id} selected={l.id === value} onClick={() => { onChange(l.id); close(); }}>
              <span className="size-2 rounded-full" style={{ background: l.color }} /> {l.name}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

function Column({ status, issues, agents, labels, onAdd, grid, stacked }: { status: Status; issues: Issue[]; agents: Agent[]; labels: Label[]; onAdd: () => void; grid?: boolean; stacked?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  const s = statusOf(status);
  return (
    <section
      ref={setNodeRef}
      className={clsx(
        'flex flex-col rounded-2xl border bg-white/[0.015] transition-colors',
        stacked ? 'min-h-0 flex-1' : grid ? 'h-[clamp(14rem,42vh,30rem)] min-w-0' : 'w-[85vw] shrink-0 snap-center sm:w-[19rem]',
        isOver ? 'border-accent/50 bg-accent/[0.04]' : 'border-white/[0.06]'
      )}
    >
      <header data-col-head className="flex items-center gap-2 px-3.5 py-3">
        <StatusIcon status={status} />
        <span className="font-medium">{s.label}</span>
        {s.parallel && <span className="rounded bg-white/[0.06] px-1 text-[10px] text-mute" title={t('Em paralelo com a etapa de cima')}>{t('paralela')}</span>}
        <span className="rounded-full bg-white/[0.06] px-1.5 text-[11px] tabular-nums text-mute">{issues.length}</span>
        <button onClick={onAdd} className="ml-auto rounded p-1 text-mute hover:bg-hover hover:text-fg" title={t('Nova issue nesta coluna')}><Plus className="size-3.5" /></button>
      </header>
      <div data-col-body className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2.5">
        {issues.map((i) => <Card key={i.id} issue={i} agents={agents} labels={labels} />)}
        {!issues.length && <div className="mx-1 rounded-xl border border-dashed border-white/[0.07] py-8 text-center text-xs text-mute">{t('Arraste uma issue para cá')}</div>}
      </div>
    </section>
  );
}

// Inclina o cartão arrastado na direção do movimento, proporcional à velocidade,
// e volta a ficar reto quando o ponteiro para.
function Tilt({ children }: { children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let lastX: number | null = null;
    let lastT = 0;
    let vx = 0;
    let angle = 0;
    let frame = 0;
    const track = (x: number) => {
      const now = performance.now();
      if (lastX !== null && now > lastT) vx = vx * 0.6 + ((x - lastX) / (now - lastT)) * 0.4;
      lastX = x;
      lastT = now;
    };
    const onMove = (e: PointerEvent) => track(e.clientX);
    const onTouch = (e: TouchEvent) => e.touches[0] && track(e.touches[0].clientX);
    const tick = () => {
      if (performance.now() - lastT > 60) vx *= 0.85;
      const target = Math.max(-10, Math.min(10, vx * 6));
      angle += (target - angle) * 0.18;
      if (el.current) el.current.style.transform = `rotate(${angle.toFixed(2)}deg) scale(1.03)`;
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('touchmove', onTouch, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onTouch);
      cancelAnimationFrame(frame);
    };
  }, []);
  return <div ref={el} className="origin-top will-change-transform" style={{ transform: 'scale(1.03)' }}>{children}</div>;
}

function Card({ issue, agents, labels, overlay }: { issue: Issue; agents: Agent[]; labels: Label[]; overlay?: boolean }) {
  const { ws } = useWs();
  const drag = useDraggable({ id: issue.id, disabled: overlay });
  const drop = useDroppable({ id: `card:${issue.id}`, disabled: overlay });
  const agent = agents.find((a) => a.id === issue.agentId);
  const running = !!issue.activeRun;
  return (
    <Link
      to={`/w/${ws.key}/issues/${ws.key}-${issue.number}`}
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      {...drag.attributes}
      onClick={(e) => Date.now() - lastDragEnd < 300 && e.preventDefault()}
      className={clsx(
        'block select-none rounded-xl border bg-gradient-to-b from-card to-panel p-3 shadow-[0_1px_0_0_rgb(var(--ink)/0.04)_inset,0_2px_8px_-4px_rgb(0_0_0/0.6)] transition hover:-translate-y-px hover:border-white/15',
        drop.isOver ? 'border-accent/60' : 'border-white/[0.07]',
        drag.isDragging && 'opacity-30',
        overlay && 'shadow-pop'
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-mute">
        <span className="font-mono">{ws.key}-{issue.number}</span>
        {running && <span className="flex items-center gap-1 rounded-full bg-amber-400/10 px-1.5 text-amber-300"><span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /> {t('trabalhando')}</span>}
        <span className="ml-auto"><PriorityIcon priority={issue.priority} /></span>
      </div>
      <div className="mt-1.5 font-medium leading-snug">{issue.title}</div>
      {issue.labelIds.length > 0 && <div className="mt-1.5"><LabelDots ids={issue.labelIds} labels={labels} /></div>}
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-mute">
        {agent ? <><AgentIcon avatar={agent.avatar} size={16} /><span className="truncate">{agent.name}</span></> : <span>{t('Sem agente')}</span>}
        {issue.costUsd > 0 && <span>· {money(issue.costUsd)}</span>}
        <span className="ml-auto shrink-0">{timeAgo(issue.updatedAt)}</span>
      </div>
    </Link>
  );
}

function ListView({ byStatus, columns, agents, labels }: { byStatus: Record<Status, Issue[]>; columns: Status[]; agents: Agent[]; labels: Label[] }) {
  const { ws } = useWs();
  return (
    <div className="flex-1 overflow-y-auto pb-20">
      {columns.map((s) =>
        byStatus[s].length ? (
          <div key={s}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-xs font-medium">
              <StatusIcon status={s} /> {statusOf(s).label} <span className="text-mute">{byStatus[s].length}</span>
            </div>
            {byStatus[s].map((i) => {
              const agent = agents.find((a) => a.id === i.agentId);
              return (
                <Link key={i.id} to={`/w/${ws.key}/issues/${ws.key}-${i.number}`} className="flex items-center gap-3 border-b border-line/50 px-4 py-2 hover:bg-hover">
                  <PriorityIcon priority={i.priority} />
                  <span className="w-16 shrink-0 font-mono text-xs text-mute">{ws.key}-{i.number}</span>
                  <StatusIcon status={i.status} />
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  {i.activeRun && <span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" />}
                  <span className="hidden md:block"><LabelDots ids={i.labelIds} labels={labels} /></span>
                  {agent && <AgentIcon avatar={agent.avatar} />}
                  <span className="hidden w-12 text-right text-xs text-mute sm:block">{timeAgo(i.updatedAt)}</span>
                </Link>
              );
            })}
          </div>
        ) : null
      )}
      {columns.every((s) => !byStatus[s].length) && <div className="p-10 text-center text-mute">{t('Nenhuma issue. Aperte')} <kbd className="rounded border border-line px-1">{t('C')}</kbd> {t('para criar.')}</div>}
    </div>
  );
}
