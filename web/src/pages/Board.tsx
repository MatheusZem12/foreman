import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from '@dnd-kit/core';
import clsx from 'clsx';
import { ArrowUpDown, Columns3, List, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Chip, MenuItem, PageLoader, Popover, PriorityIcon, Segmented, Spinner, StatusIcon, useToast } from '../components/ui';
import { LabelDots } from '../components/pickers';
import { STATUSES, stageGroups, statusOf } from '../lib/constants';
import { useAgents, useLabels, useMe, useStages } from '../lib/queries';
import { PAGE_MORE, loadStage, sortIssues, upsertIssue, useBoard, type BoardFilters, type BoardSort } from '../lib/board';
import { money, timeAgo } from '../lib/format';
import { api } from '../lib/api';
import type { Agent, Issue, Label, Status } from '../lib/types';
import { AgentIcon } from '../components/AgentIcon';
import { t } from '../lib/i18n';

// Marks the end of a drag: the click right after it must not open the issue.
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
    /* no storage */
  }
}

// The board's display belongs to each person, per workspace (side by side or in a
// grid). The column ORDER comes only from the workflow: it changes in Workflow & automations.
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
    api.put(`/me/prefs/board:${wsId}`, next).catch(() => { /* stays in this session only */ });
  };
  return [layout, save] as const;
}

// In side-by-side mode, the mouse wheel moves sideways (unless it is over a column
// that scrolls vertically). Dragging the background doesn't scroll: holding and
// dragging is only for moving cards; on phones, the finger scrolls as usual.
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
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el]);
}

const NONE: Issue[] = [];

const SORTS: [BoardSort, () => string][] = [
  ['manual', () => t('Manual (drag)')],
  ['newest', () => t('Newest')],
  ['oldest', () => t('Oldest')],
  ['updated', () => t('Last updated')],
  ['priority', () => t('Priority')]
];

// Ordem de cada etapa, de cada pessoa (neste navegador). Encerradas: as mais recentes.
function useStageSorts(wsId: string) {
  const key = `foreman.sorts.${wsId}`;
  const [sorts, setSorts] = useState<Record<string, BoardSort>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {
      return {};
    }
  });
  const set = (stage: string, sort: BoardSort) => {
    const next = { ...sorts, [stage]: sort };
    setSorts(next);
    writePref(key, JSON.stringify(next));
  };
  const of = (stage: string): BoardSort => sorts[stage] ?? (statusOf(stage).closes ? 'updated' : 'manual');
  return [sorts, of, set] as const;
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function Board() {
  const { ws, openNewIssue } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: labels = [] } = useLabels(ws.id);
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();

  const [view, setView] = useState<View>(() => readPref('foreman.view', 'board'));
  const [who, setWho] = useState<'all' | 'mine' | string>('all');
  const [params] = useSearchParams();
  const [labelFilter, setLabelFilter] = useState<string | null>(() => params.get('label'));
  const [text, setText] = useState('');
  // Filters and search go to the server; the board only brings the first of each stage.
  const q = useDebounced(text.trim(), 300);
  const filters: BoardFilters = { q, who, label: labelFilter ?? '' };
  const [sorts, sortOf, setSort] = useStageSorts(ws.id);
  const { data: board, isLoading } = useBoard(ws.id, filters, sorts);
  const issues = board?.issues;
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const loadMore = async (stage: string) => {
    const have = (issues ?? []).filter((i) => i.status === stage).length;
    if (loading[stage] || have >= (board?.counts[stage] ?? 0)) return;
    setLoading((l) => ({ ...l, [stage]: true }));
    try {
      await loadStage(qc, ws.id, filters, stage, sortOf(stage), have, PAGE_MORE);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setLoading((l) => ({ ...l, [stage]: false }));
    }
  };
  // Changing a stage's order reloads only that stage, with as many as were loaded.
  const changeSort = async (stage: string, sort: BoardSort) => {
    setSort(stage, sort);
    const have = (issues ?? []).filter((i) => i.status === stage).length;
    setLoading((l) => ({ ...l, [stage]: true }));
    try {
      await loadStage(qc, ws.id, filters, stage, sort, 0, Math.max(have, 30), true);
    } finally {
      setLoading((l) => ({ ...l, [stage]: false }));
    }
  };
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
      if (tt && !`${ws.key}-${i.number} ${i.title}`.toLowerCase().includes(tt) && !(q && q.toLowerCase() === tt)) return false;
      return true;
    });
  }, [issues, who, labelFilter, text, me, ws.key]);

  const { data: stages } = useStages(ws.id);
  const byStatus = useMemo(() => {
    const map = {} as Record<Status, Issue[]>;
    for (const s of STATUSES) map[s.id] = [];
    for (const i of filtered) (map[i.status] ??= []).push(i);
    for (const s of STATUSES) map[s.id] = sortIssues(map[s.id], sortOf(s.id));
    return map;
  }, [filtered, sorts, stages]); // eslint-disable-line react-hooks/exhaustive-deps

  const working = board?.working ?? 0;
  // The columns are memoized: they get the same functions on every render (which call
  // the latest version), so typing in the filter or an issue arriving in real time only
  // re-renders the cards that changed.
  const latest = useRef({ changeSort, loadMore, openNewIssue });
  latest.current = { changeSort, loadMore, openNewIssue };
  const onSort = useCallback((s: Status, v: BoardSort) => { latest.current.changeSort(s, v); }, []);
  const onMore = useCallback((s: Status) => { latest.current.loadMore(s); }, []);
  const onAdd = useCallback((s: Status) => latest.current.openNewIssue(s), []);
  const colProps = (s: Status) => ({
    status: s, issues: byStatus[s] ?? NONE, total: board?.counts[s] ?? 0, sort: sortOf(s), loading: !!loading[s],
    onSort, onMore, agents, labels, onAdd, wsKey: ws.key
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } })
  );

  const move = async (issue: Issue, status: Status, position: number) => {
    upsertIssue(qc, ws.id, { ...issue, status, position });
    try {
      const res = await api.patch<{ issue: Issue; warning?: string }>(`/issues/${issue.id}`, { status, position });
      if (res.warning) toast('error', res.warning);
    } catch (err) {
      upsertIssue(qc, ws.id, issue);
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
    // Position between the neighbours: a single UPDATE, without renumbering the column.
    const before = list[index - 1]?.position;
    const after = list[index]?.position;
    const position =
      before === undefined && after === undefined ? 0 : before === undefined ? after! - 1024 : after === undefined ? before + 1024 : (before + after) / 2;
    if (status === issue.status && position === issue.position) return;
    if (sortOf(status) !== 'manual' && status === issue.status) return; // reordering only applies to the manual order
    move(issue, status, position);
  };

  // Stages that close as cancelled stay hidden, unless the person asks for them.
  const columns = STATUSES.filter((s) => s.closes !== 'cancelled' || showCancelled).map((s) => s.id);
  // Parallel stages share the same column, one under the other.
  const groups = stageGroups(STATUSES.filter((s) => columns.includes(s.id))).map((g) => g.map((s) => s.id));

  const active = who !== 'all' || !!labelFilter || !!text;
  return (
    <div className="flex h-full flex-col">
      <div className="toolbar">
        <h1 className="mr-1 hidden text-[15px] font-semibold tracking-tight lg:block">{t('Issues')}</h1>
        <div className="seg">
          {[
            ['all', t('All')],
            ['mine', t('Mine')]
          ].map(([id, label]) => (
            <button key={id} onClick={() => setWho(id)} aria-pressed={who === id} className="seg-item">{label}</button>
          ))}
          <AgentFilter agents={agents} value={who} onChange={setWho} />
        </div>
        <LabelFilter labels={labels} value={labelFilter} onChange={setLabelFilter} />
        {active && <button onClick={() => { setWho('all'); setLabelFilter(null); setText(''); }} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-mute transition-colors hover:bg-hover hover:text-fg"><X className="size-3" /> {t('Clear')}</button>}
        {/* On a phone the search takes a row of its own, under the filters. */}
        <div className="relative order-last w-full sm:order-none sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Filter…')} aria-label={t('Filter…')} className="field-input h-8 py-1 pl-8" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {working > 0 && (
            <span className="hidden items-center gap-1.5 text-xs text-amber-400 sm:flex">
              <span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /> {working} {working === 1 ? t('agent working') : t('agents working')}
            </span>
          )}
          <Popover
            align="right"
            trigger={() => <Chip title={t('View')}><SlidersHorizontal className="size-3.5" /> <span className="hidden sm:inline">{t('View')}</span></Chip>}
          >
            {() => (
              <>
                <MenuItem selected={showCancelled} onClick={() => setShowCancelled(!showCancelled)}>{t('Show cancelled')}</MenuItem>
                <div className="my-1 border-t border-line" />
                <div className="label-caps px-2.5 pb-1 pt-1">{t('Columns (just for you)')}</div>
                <MenuItem selected={layout.mode === 'side'} onClick={() => saveLayout({ mode: 'side' })}>{t('Side by side')}</MenuItem>
                <MenuItem selected={layout.mode === 'grid'} onClick={() => saveLayout({ mode: 'grid' })}>{t('Stacked')}</MenuItem>
                {layout.mode === 'grid' && (
                  <div className="hidden items-center gap-1 px-2.5 py-1.5 text-xs text-mute sm:flex">
                    {t('Per row')}
                    {[1, 2, 3, 4].map((n) => (
                      <button key={n} onClick={() => saveLayout({ perRow: n })} className={clsx('ml-1 rounded-md px-2 py-0.5', layout.perRow === n ? 'bg-hover text-fg' : 'hover:text-fg')}>{n}</button>
                    ))}
                  </div>
                )}
                <div className="max-w-60 px-2.5 pb-1.5 pt-1 text-[11px] leading-snug text-mute">{t('Column order follows the workflow (Workflow & automations).')}</div>
              </>
            )}
          </Popover>
          <Segmented<View>
            items={[{ id: 'board', label: <Columns3 className="size-3.5" />, hint: t('Board') }, { id: 'list', label: <List className="size-3.5" />, hint: t('List') }]}
            value={view}
            onChange={(v) => { setView(v); writePref('foreman.view', v); }}
          />
        </div>
      </div>

      {isLoading ? (
        <PageLoader />
      ) : view === 'list' ? (
        <ListView byStatus={byStatus} columns={columns} agents={agents} labels={labels} counts={board?.counts ?? {}} loading={loading} onMore={loadMore} />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          {layout.mode === 'grid' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
              <div
                className="grid grid-cols-1 gap-3 sm:[grid-template-columns:repeat(var(--per-row),minmax(0,1fr))]"
                style={{ '--per-row': layout.perRow } as React.CSSProperties}
              >
                {groups.map((g) => g.length === 1
                  ? <Column key={g[0]} grid {...colProps(g[0])} />
                  : (
                    <div key={g[0]} className="flex h-[clamp(20rem,60vh,40rem)] min-w-0 flex-col gap-3">
                      {g.map((s) => <Column key={s} stacked {...colProps(s)} />)}
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <div ref={setScroller} className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-3 gap-3 overflow-x-auto overscroll-x-contain p-3 md:snap-none md:p-5">
              {groups.map((g) => g.length === 1
                ? <Column key={g[0]} {...colProps(g[0])} />
                : (
                  <div key={g[0]} className={clsx(COL_W, 'flex flex-col gap-3')}>
                    {g.map((s) => <Column key={s} stacked {...colProps(s)} />)}
                  </div>
                ))}
            </div>
          )}
          <DragOverlay dropAnimation={null}>
            {dragging && <Tilt><Card issue={dragging} agents={agents} labels={labels} wsKey={ws.key} overlay /></Tilt>}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

// A column's width side by side: nearly the whole screen on a phone (the next one peeks
// in, so it is clear there is more), a fixed width from a tablet up.
const COL_W = 'w-[min(86vw,20rem)] shrink-0 snap-start sm:w-[19.5rem]';

function AgentFilter({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (v: string) => void }) {
  const current = agents.find((a) => a.id === value);
  return (
    <Popover
      trigger={() => (
        <button aria-pressed={!!current} className="seg-item max-w-40">{current ? <><AgentIcon avatar={current.avatar} size={14} /><span className="truncate">{current.name}</span></> : t('Agents')}</button>
      )}
    >
      {(close) => (
        <>
          {agents.map((a) => (
            <MenuItem key={a.id} selected={a.id === value} onClick={() => { onChange(a.id === value ? 'all' : a.id); close(); }}>
              <AgentIcon avatar={a.avatar} /> <span className="truncate">{a.name}</span>
            </MenuItem>
          ))}
          {!agents.length && <div className="px-2.5 py-1.5 text-mute">{t('No agents created yet.')}</div>}
        </>
      )}
    </Popover>
  );
}

function LabelFilter({ labels, value, onChange }: { labels: Label[]; value: string | null; onChange: (v: string | null) => void }) {
  if (!labels.length) return null;
  const current = labels.find((l) => l.id === value);
  return (
    <Popover trigger={() => <Chip className={current ? 'text-fg' : ''}>{current ? <><span className="size-2 shrink-0 rounded-full" style={{ background: current.color }} /><span className="truncate">{current.name}</span></> : t('Label')}</Chip>}>
      {(close) => (
        <>
          <MenuItem selected={!value} onClick={() => { onChange(null); close(); }}>{t('All')}</MenuItem>
          {labels.map((l) => (
            <MenuItem key={l.id} selected={l.id === value} onClick={() => { onChange(l.id); close(); }}>
              <span className="size-2 rounded-full" style={{ background: l.color }} /> <span className="truncate">{l.name}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

const Column = memo(function Column({ status, issues, total, sort, loading, onSort, onMore, agents, labels, onAdd, wsKey, grid, stacked }: {
  status: Status; issues: Issue[]; total: number; sort: BoardSort; loading: boolean; onSort: (s: Status, v: BoardSort) => void; onMore: (s: Status) => void;
  agents: Agent[]; labels: Label[]; onAdd: (s: Status) => void; wsKey: string; grid?: boolean; stacked?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  const s = statusOf(status);
  // Got near the end of the column: fetch the next page of this stage only.
  const sentinel = useRef<HTMLDivElement>(null);
  const more = issues.length < total;
  // Recreates the observer when the page finishes: if the end is still visible, fetch the next.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || loading) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && onMore(status), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, issues.length, loading, onMore, status]);
  return (
    <section
      ref={setNodeRef}
      className={clsx(
        'flex flex-col rounded-xl transition-colors',
        stacked ? 'min-h-0 flex-1' : grid ? 'h-[clamp(14rem,42vh,30rem)] min-w-0' : COL_W,
        isOver ? 'bg-accent/[0.07] ring-1 ring-inset ring-accent/40' : 'bg-white/[0.025]'
      )}
    >
      <header data-col-head className="flex h-11 shrink-0 items-center gap-2 pl-3.5 pr-2">
        <StatusIcon status={status} />
        <span className="min-w-0 truncate font-medium">{s.label}</span>
        {s.parallel && <span className="badge shrink-0 px-1 py-0 text-[10px]" title={t('In parallel with the stage above')}>{t('parallel')}</span>}
        <span className="shrink-0 text-xs tabular-nums text-mute" title={more ? t('{0} loaded of {1}', issues.length, total) : undefined}>{total}</span>
        <Popover align="right" trigger={() => (
          <button className={clsx('icon-btn ml-auto size-7', sort !== 'manual' && 'text-accent')} title={t('This stage\'s order: {0}', SORTS.find(([k]) => k === sort)![1]())}><ArrowUpDown className="size-3.5" /></button>
        )}>
          {(close) => (
            <>
              <div className="label-caps px-2.5 pb-1 pt-1">{t('This stage\'s order')}</div>
              {SORTS.map(([k, label]) => <MenuItem key={k} selected={sort === k} onClick={() => { onSort(status, k); close(); }}>{label()}</MenuItem>)}
            </>
          )}
        </Popover>
        <button onClick={() => onAdd(status)} className="icon-btn size-7" title={t('New issue in this column')}><Plus className="size-3.5" /></button>
      </header>
      <div data-col-body className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain px-2 pb-2">
        {issues.map((i) => <Card key={i.id} issue={i} agents={agents} labels={labels} wsKey={wsKey} />)}
        {!issues.length && <div className="px-3 py-8 text-center text-xs text-mute/80">{t('Drag an issue here')}</div>}
        {more && (
          <div ref={sentinel}>
            <button onClick={() => onMore(status)} disabled={loading} className="grid w-full place-items-center rounded-lg py-2 text-xs text-mute transition-colors hover:bg-hover hover:text-fg">
              {loading ? <Spinner /> : t('Load more ({0} of {1})', issues.length, total)}
            </button>
          </div>
        )}
      </div>
    </section>
  );
});

// Tilts the dragged card in the direction of movement, in proportion to the speed,
// and straightens it again when the pointer stops.
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

const Card = memo(function Card({ issue, agents, labels, wsKey, overlay }: { issue: Issue; agents: Agent[]; labels: Label[]; wsKey: string; overlay?: boolean }) {
  const drag = useDraggable({ id: issue.id, disabled: overlay });
  const drop = useDroppable({ id: `card:${issue.id}`, disabled: overlay });
  const agent = agents.find((a) => a.id === issue.agentId);
  const running = !!issue.activeRun;
  return (
    <Link
      to={`/w/${wsKey}/issues/${wsKey}-${issue.number}`}
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      {...drag.attributes}
      draggable={false}
      onClick={(e) => Date.now() - lastDragEnd < 300 && e.preventDefault()}
      className={clsx(
        'block shrink-0 select-none rounded-lg border bg-panel p-3 transition-colors hover:border-white/20 [-webkit-touch-callout:none]',
        drop.isOver ? 'border-accent/60' : 'border-line',
        drag.isDragging && 'opacity-30',
        overlay && 'shadow-pop'
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-mute">
        <span className="font-mono">{wsKey}-{issue.number}</span>
        {running && <span className="flex items-center gap-1 text-amber-400"><span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /> {t('working')}</span>}
        <span className="ml-auto"><PriorityIcon priority={issue.priority} /></span>
      </div>
      <div className="mt-1.5 line-clamp-3 font-medium leading-snug [overflow-wrap:anywhere]">{issue.title}</div>
      {issue.labelIds.length > 0 && <div className="mt-2"><LabelDots ids={issue.labelIds} labels={labels} /></div>}
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-mute">
        {agent ? <><AgentIcon avatar={agent.avatar} size={16} /><span className="truncate">{agent.name}</span></> : <span>{t('No agent')}</span>}
        {issue.costUsd > 0 && <span className="shrink-0">· {money(issue.costUsd)}</span>}
        <span className="ml-auto shrink-0">{timeAgo(issue.updatedAt)}</span>
      </div>
    </Link>
  );
});

function ListView({ byStatus, columns, agents, labels, counts, loading, onMore }: {
  byStatus: Record<Status, Issue[]>; columns: Status[]; agents: Agent[]; labels: Label[];
  counts: Record<string, number>; loading: Record<string, boolean>; onMore: (s: string) => void;
}) {
  const { ws } = useWs();
  return (
    <div className="flex-1 overflow-y-auto pb-24">
      {columns.map((s) =>
        byStatus[s]?.length ? (
          <div key={s}>
            <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line bg-bg px-4 text-xs font-medium md:px-5">
              <StatusIcon status={s} /> {statusOf(s).label} <span className="font-normal tabular-nums text-mute">{counts[s] ?? byStatus[s].length}</span>
            </div>
            {byStatus[s].map((i) => <ListRow key={i.id} issue={i} agents={agents} labels={labels} wsKey={ws.key} />)}
            {byStatus[s].length < (counts[s] ?? 0) && (
              <button onClick={() => onMore(s)} disabled={loading[s]} className="grid w-full place-items-center border-b border-line/60 py-2.5 text-xs text-mute transition-colors hover:bg-hover hover:text-fg">
                {loading[s] ? <Spinner /> : t('Load more ({0} of {1})', byStatus[s].length, counts[s])}
              </button>
            )}
          </div>
        ) : null
      )}
      {columns.every((s) => !byStatus[s]?.length) && <div className="p-10 text-center text-mute">{t('No issues. Press')} <kbd className="kbd">{t('C')}</kbd> {t('to create one.')}</div>}
    </div>
  );
}

const ListRow = memo(function ListRow({ issue: i, agents, labels, wsKey }: { issue: Issue; agents: Agent[]; labels: Label[]; wsKey: string }) {
  const agent = agents.find((a) => a.id === i.agentId);
  return (
    <Link to={`/w/${wsKey}/issues/${wsKey}-${i.number}`} className="flex min-h-10 items-center gap-3 border-b border-line/60 px-4 py-2 transition-colors hover:bg-white/[0.03] md:px-5">
      <PriorityIcon priority={i.priority} />
      <span className="hidden w-16 shrink-0 font-mono text-xs text-mute sm:block">{wsKey}-{i.number}</span>
      <span className="min-w-0 flex-1 truncate">{i.title}</span>
      {i.activeRun && <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-amber-400" title={t('working')} />}
      <span className="hidden max-w-[40%] shrink-0 overflow-hidden lg:block"><LabelDots ids={i.labelIds} labels={labels} /></span>
      {agent && <span title={agent.name} className="inline-flex"><AgentIcon avatar={agent.avatar} /></span>}
      <span className="w-12 shrink-0 text-right text-xs text-mute">{timeAgo(i.updatedAt)}</span>
    </Link>
  );
});
