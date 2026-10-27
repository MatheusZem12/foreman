import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent
} from '@dnd-kit/core';
import clsx from 'clsx';
import { Columns3, List, ListFilter, Plus, Search } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, Chip, MenuItem, Popover, PriorityIcon, Spinner, StatusIcon, useToast } from '../components/ui';
import { LabelDots } from '../components/pickers';
import { BOARD_STATUSES, STATUSES, statusOf } from '../lib/constants';
import { useAgents, useIssues, useLabels, useMe } from '../lib/queries';
import { money, timeAgo } from '../lib/format';
import { api } from '../lib/api';
import type { Agent, Issue, Label, Status } from '../lib/types';

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

  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (issues ?? []).filter((i) => {
      if (who === 'mine' && i.createdBy !== me?.id) return false;
      if (who !== 'all' && who !== 'mine' && i.agentId !== who) return false;
      if (labelFilter && !i.labelIds.includes(labelFilter)) return false;
      if (t && !`${ws.key}-${i.number} ${i.title}`.toLowerCase().includes(t)) return false;
      return true;
    });
  }, [issues, who, labelFilter, text, me, ws.key]);

  const byStatus = useMemo(() => {
    const map = {} as Record<Status, Issue[]>;
    for (const s of STATUSES) map[s.id] = [];
    for (const i of filtered) map[i.status].push(i);
    for (const s of STATUSES) map[s.id] = sortIssues(map[s.id], sort);
    return map;
  }, [filtered, sort]);

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
      else if (status === 'todo' && issue.status !== 'todo' && issue.agentId) toast('info', `${ws.key}-${issue.number} foi para a fila do agente`);
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

  const columns = [...BOARD_STATUSES, ...(showCancelled ? (['cancelled'] as Status[]) : [])];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 md:px-4">
        <h1 className="mr-1 hidden font-semibold md:block">Issues</h1>
        <div className="flex rounded-md border border-line p-0.5">
          {[
            ['all', 'Todas'],
            ['mine', 'Minhas']
          ].map(([id, label]) => (
            <button key={id} onClick={() => setWho(id)} className={clsx('rounded px-2 py-0.5 text-xs', who === id ? 'bg-hover text-fg' : 'text-dim')}>{label}</button>
          ))}
          <AgentFilter agents={agents} value={who} onChange={setWho} />
        </div>
        <div className="relative hidden sm:block">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filtrar…" className="field-input h-7 w-44 pl-7" />
        </div>
        <LabelFilter labels={labels} value={labelFilter} onChange={setLabelFilter} />
        <div className="ml-auto flex items-center gap-1.5">
          <span className={clsx('hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs sm:flex', working ? 'text-amber-400' : 'text-mute')}>
            <span className={clsx('size-1.5 rounded-full', working ? 'animate-pulse-soft bg-amber-400' : 'bg-mute')} /> {working} {working === 1 ? 'agente trabalhando' : 'agentes trabalhando'}
          </span>
          <Popover
            align="right"
            trigger={() => <Chip><ListFilter className="size-3.5" /> <span className="hidden sm:inline">Exibir</span></Chip>}
          >
            {(close) => (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] text-mute">Ordenar</div>
                {(
                  [
                    ['manual', 'Manual (arrastar)'],
                    ['priority', 'Prioridade'],
                    ['updated', 'Atualização']
                  ] as [Sort, string][]
                ).map(([id, label]) => (
                  <MenuItem key={id} selected={sort === id} onClick={() => { setSort(id); writePref('mx.sort', id); close(); }}>{label}</MenuItem>
                ))}
                <div className="my-1 border-t border-line" />
                <MenuItem selected={showCancelled} onClick={() => setShowCancelled(!showCancelled)}>Mostrar canceladas</MenuItem>
              </>
            )}
          </Popover>
          <div className="flex rounded-md border border-line p-0.5">
            <button onClick={() => { setView('board'); writePref('mx.view', 'board'); }} className={clsx('rounded p-1', view === 'board' ? 'bg-hover text-fg' : 'text-mute')} title="Quadro"><Columns3 className="size-3.5" /></button>
            <button onClick={() => { setView('list'); writePref('mx.view', 'list'); }} className={clsx('rounded p-1', view === 'list' ? 'bg-hover text-fg' : 'text-mute')} title="Lista"><List className="size-3.5" /></button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid flex-1 place-items-center"><Spinner /></div>
      ) : view === 'list' ? (
        <ListView byStatus={byStatus} columns={columns} agents={agents} labels={labels} />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="flex flex-1 snap-x snap-mandatory gap-3 overflow-x-auto p-3 md:snap-none md:p-4">
            {columns.map((s) => (
              <Column key={s} status={s} issues={byStatus[s]} agents={agents} labels={labels} onAdd={() => openNewIssue(s)} />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging && <Card issue={dragging} agents={agents} labels={labels} overlay />}
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
        <button className={clsx('rounded px-2 py-0.5 text-xs', current ? 'bg-hover text-fg' : 'text-dim')}>{current ? `${current.avatar} ${current.name}` : 'Agentes'}</button>
      )}
    >
      {(close) =>
        agents.map((a) => (
          <MenuItem key={a.id} selected={a.id === value} onClick={() => { onChange(a.id === value ? 'all' : a.id); close(); }}>
            <Avatar emoji={a.avatar} /> {a.name}
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
    <Popover trigger={() => <Chip className={current ? 'text-fg' : ''}>{current ? <><span className="size-2 rounded-full" style={{ background: current.color }} />{current.name}</> : 'Label'}</Chip>}>
      {(close) => (
        <>
          <MenuItem selected={!value} onClick={() => { onChange(null); close(); }}>Todas</MenuItem>
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

function Column({ status, issues, agents, labels, onAdd }: { status: Status; issues: Issue[]; agents: Agent[]; labels: Label[]; onAdd: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  const s = statusOf(status);
  return (
    <section
      ref={setNodeRef}
      className={clsx(
        'flex w-[85vw] shrink-0 snap-center flex-col rounded-xl border bg-panel/60 sm:w-72',
        isOver ? 'border-accent/50' : 'border-line/70'
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <StatusIcon status={status} />
        <span className="font-medium">{s.label}</span>
        <span className="text-mute">{issues.length}</span>
        <button onClick={onAdd} className="ml-auto rounded p-1 text-mute hover:bg-hover hover:text-fg" title="Nova issue nesta coluna"><Plus className="size-3.5" /></button>
      </header>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {issues.map((i) => <Card key={i.id} issue={i} agents={agents} labels={labels} />)}
        {!issues.length && <div className="py-6 text-center text-xs text-mute">Nenhuma issue</div>}
      </div>
    </section>
  );
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
        'block select-none rounded-lg border bg-card p-2.5 transition-colors hover:border-line hover:bg-hover',
        drop.isOver ? 'border-accent/60' : 'border-line/60',
        drag.isDragging && 'opacity-30',
        overlay && 'rotate-1 shadow-2xl'
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-mute">
        <span className="font-mono">{ws.key}-{issue.number}</span>
        {running && <span className="flex items-center gap-1 text-amber-400"><span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /> trabalhando</span>}
        <span className="ml-auto"><PriorityIcon priority={issue.priority} /></span>
      </div>
      <div className="mt-1 font-medium leading-snug">{issue.title}</div>
      {issue.labelIds.length > 0 && <div className="mt-1.5"><LabelDots ids={issue.labelIds} labels={labels} /></div>}
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-mute">
        {agent ? <><Avatar emoji={agent.avatar} size={16} /><span className="truncate">{agent.name}</span></> : <span>Sem agente</span>}
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
                  {agent && <Avatar emoji={agent.avatar} />}
                  <span className="hidden w-12 text-right text-xs text-mute sm:block">{timeAgo(i.updatedAt)}</span>
                </Link>
              );
            })}
          </div>
        ) : null
      )}
      {columns.every((s) => !byStatus[s].length) && <div className="p-10 text-center text-mute">Nenhuma issue. Aperte <kbd className="rounded border border-line px-1">C</kbd> para criar.</div>}
    </div>
  );
}
