import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft, ChevronDown, ChevronRight, CircleStop, GitMerge, MoreHorizontal, Play, Send, Swords, Trash2, Undo2, Wand2
} from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, Button, Empty, MenuItem, Modal, Popover, Spinner, StatusIcon, Toggle, useToast } from '../components/ui';
import { AgentPicker, BranchPicker, LabelPicker, PriorityPicker, RepoScopePicker, StatusPicker } from '../components/pickers';
import { api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { compact, duration, money, runSeconds, timeAgo } from '../lib/format';
import { useAgents, useCan, useRepos, useUsers } from '../lib/queries';
import type { Comment, Issue, IssueDetail, IssueRepo, Repo, RepoDiff, RepoMerge, Run, RunEvent } from '../lib/types';
import { AgentIcon } from '../components/AgentIcon';

type Tab = 'atividade' | 'resumo' | 'diff' | 'execucoes';

export function IssuePage() {
  const { ref } = useParams();
  const { ws } = useWs();
  const { data, isLoading, error } = useQuery({ queryKey: ['issue-ref', ref], queryFn: () => api.get<IssueDetail>(`/issues/${ref}`) });
  // A página usa a chave por id (que o tempo real atualiza); a busca por "LING-12" só resolve o id.
  const id = data?.issue.id;
  const detail = useQuery({
    queryKey: ['issue', id],
    queryFn: () => api.get<IssueDetail>(`/issues/${id}`),
    enabled: !!id,
    initialData: data,
    initialDataUpdatedAt: () => Date.now()
  });

  if (isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (error || !detail.data) return <Empty>Issue não encontrada. <Link className="text-accent" to={`/w/${ws.key}`}>Voltar</Link></Empty>;
  return <IssueView detail={detail.data} />;
}

function patchCache(qc: ReturnType<typeof useQueryClient>, issue: Issue) {
  qc.setQueryData<IssueDetail>(['issue', issue.id], (d) => (d ? { ...d, issue } : d));
  qc.setQueryData<Issue[]>(['issues', issue.workspaceId], (l) => l?.map((i) => (i.id === issue.id ? issue : i)));
}

function IssueView({ detail }: { detail: IssueDetail }) {
  const { issue, runs, comments } = detail;
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { data: repos = [] } = useRepos(ws.id);
  const canEdit = useCan('issue.update');
  const canRun = useCan('issue.run');
  const canMerge = useCan('issue.merge');
  const canDelete = useCan('issue.delete');
  const [tab, setTab] = useState<Tab>('atividade');
  const [merging, setMerging] = useState(false);
  const [showProps, setShowProps] = useState(false);

  const patch = async (body: Partial<Issue>) => {
    patchCache(qc, { ...issue, ...body });
    try {
      const res = await api.patch<{ issue: Issue; warning?: string }>(`/issues/${issue.id}`, body);
      patchCache(qc, res.issue);
      if (res.warning) toast('error', res.warning);
    } catch (err) {
      patchCache(qc, issue);
      toast('error', (err as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast('success', ok);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  // Escopo: todos os repositórios (a IA escolhe) ou só os escolhidos, cada um com base → destino.
  const saveRepos = async (all: boolean, list: { repoId: string; baseBranch?: string; targetBranch?: string }[]) => {
    try {
      patchCache(qc, await api.put<Issue>(`/issues/${issue.id}/repos`, { all, repos: list }));
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  const setBranch = (repoId: string, b: { baseBranch?: string; targetBranch?: string }) =>
    saveRepos(issue.allRepos, issue.repos.map((r) => (r.repoId === repoId ? { repoId, baseBranch: r.baseBranch, targetBranch: r.targetBranch, ...b } : { repoId: r.repoId, baseBranch: r.baseBranch, targetBranch: r.targetBranch })));

  const active = !!issue.activeRun;
  const pendingRepos = issue.repos.filter((r) => r.changed && !r.mergedInto);
  const hasCommits = pendingRepos.length > 0;
  const closed = issue.status === 'done' || issue.status === 'cancelled';
  const lastRun = runs[runs.length - 1];
  const conflict = issue.repos.some((r) => r.conflict);

  const properties = (
    <div className="space-y-0.5">
      <PropRow label="Status"><StatusPicker variant="row" value={issue.status} onChange={(status) => patch({ status })} /></PropRow>
      <PropRow label="Prioridade"><PriorityPicker variant="row" value={issue.priority} onChange={(priority) => patch({ priority })} /></PropRow>
      <PropRow label="Agente"><AgentPicker variant="row" value={issue.agentId} onChange={(agentId) => patch({ agentId })} /></PropRow>
      <PropRow label="Labels"><LabelPicker variant="row" ws={ws.id} value={issue.labelIds} onChange={(labelIds) => patch({ labelIds })} /></PropRow>
      <PropRow label="Repositórios">
        <RepoScopePicker variant="row" ws={ws.id} value={issue.allRepos ? [] : issue.repos.map((r) => r.repoId)}
          onChange={(ids) => saveRepos(!ids.length, ids.map((repoId) => ({ repoId, ...pick(issue.repos.find((r) => r.repoId === repoId)) })))} />
      </PropRow>
      {issue.repos.map((r) => <IssueRepoRow key={r.repoId} r={r} repo={repos.find((x) => x.id === r.repoId)} locked={!canEdit || issue.status === 'done' || issue.status === 'cancelled'} onChange={(b) => setBranch(r.repoId, b)} />)}
      <div className="space-y-1 px-2 pt-3 text-xs text-mute">
        {issue.branch && <div className="truncate font-mono" title={issue.branch}>{issue.branch}</div>}
        <div>Custo total: <span className="text-dim">{money(issue.costUsd)}</span> · {runs.length} execução(ões)</div>
        <div>Criada {timeAgo(issue.createdAt)} · atualizada {timeAgo(issue.updatedAt)}</div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line/70 bg-panel/40 px-3 py-2.5 backdrop-blur md:px-5">
        <button onClick={() => nav(`/w/${ws.key}`)} className="rounded p-1 text-mute hover:bg-hover hover:text-fg"><ArrowLeft className="size-4" /></button>
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-xs text-dim">{ws.key}-{issue.number}</span>
        <StatusIcon status={issue.status} />
        {active && <span className="flex items-center gap-1 text-xs text-amber-400"><span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /> trabalhando</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {active && canRun && <Button size="sm" variant="danger" onClick={() => act(() => api.post(`/issues/${issue.id}/cancel`))}><CircleStop className="size-3.5" /> Parar</Button>}
          {canRun && !active && !closed && !runs.length && issue.agentId && (
            <Button size="sm" variant="primary" onClick={() => act(() => api.post(`/issues/${issue.id}/run`, { kind: 'initial' }), 'Na fila do agente')}><Play className="size-3.5" /> Executar</Button>
          )}
          {canRun && !active && !closed && lastRun?.status === 'failed' && (
            <Button size="sm" onClick={() => act(() => api.post(`/issues/${issue.id}/run`, { kind: lastRun.kind, request: lastRun.request }), 'Na fila de novo')}><Undo2 className="size-3.5" /> Tentar de novo</Button>
          )}
          {canRun && conflict && !active && (
            <Button size="sm" variant="outline" onClick={() => act(() => api.post(`/issues/${issue.id}/run`, { kind: 'conflict' }), 'IA resolvendo o conflito')}><Swords className="size-3.5" /> Resolver conflito com IA</Button>
          )}
          {canMerge && !active && !closed && hasCommits && !conflict && (
            <Button size="sm" variant="success" onClick={() => setMerging(true)}>
              <GitMerge className="size-3.5" /> Merge{pendingRepos.length > 1 ? ` (${pendingRepos.length} repos)` : <span className="hidden sm:inline"> em {pendingRepos[0].targetBranch}</span>}
            </Button>
          )}
          <Popover align="right" trigger={() => <button className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><MoreHorizontal className="size-4" /></button>}>
            {(close) => (
              <>
                {canMerge && !closed && hasCommits && (
                  <MenuItem onClick={() => { close(); if (confirm('Descartar? Apaga o worktree e a branch da issue (local e remota).')) act(() => api.post(`/issues/${issue.id}/discard`), 'Descartada'); }}>
                    <Undo2 className="size-4" /> Descartar alterações
                  </MenuItem>
                )}
                {canDelete && <MenuItem danger onClick={() => {
                  close();
                  if (confirm('Excluir a issue, o histórico e as branches?')) act(async () => { await api.del(`/issues/${issue.id}`); nav(`/w/${ws.key}`); });
                }}><Trash2 className="size-4" /> Excluir issue</MenuItem>}
                {!canDelete && !(canMerge && !closed && hasCommits) && <div className="px-2 py-1.5 text-xs text-mute">Nenhuma ação disponível.</div>}
              </>
            )}
          </Popover>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 pb-10 pt-5 md:px-6">
            <TitleEditor issue={issue} onSave={(title) => patch({ title })} />
            <DescriptionEditor issue={issue} onSave={(description) => patch({ description })} />

            <button onClick={() => setShowProps(!showProps)} className="mt-4 flex w-full items-center gap-1 rounded-md border border-line px-2 py-1.5 text-xs text-dim lg:hidden">
              {showProps ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Propriedades
            </button>
            {showProps && <div className="mt-2 rounded-lg border border-line p-1 lg:hidden">{properties}</div>}

            <div className="mt-6 flex gap-1 border-b border-line">
              {([
                ['atividade', 'Atividade'],
                ['resumo', 'Resumo'],
                ['diff', 'Diff'],
                ['execucoes', 'Execuções']
              ] as [Tab, string][]).map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} className={clsx('-mb-px border-b-2 px-3 py-2 transition-colors', tab === id ? 'border-accent font-medium text-fg' : 'border-transparent text-mute hover:text-fg')}>{label}</button>
              ))}
            </div>
            <div className="pt-4">
              {tab === 'atividade' && <Activity issue={issue} runs={runs} comments={comments} />}
              {tab === 'resumo' && <SummaryTab issue={issue} onSave={(summary) => patch({ summary })} />}
              {tab === 'diff' && <DiffTab issue={issue} />}
              {tab === 'execucoes' && <RunsTable runs={runs} />}
            </div>
          </div>
        </div>
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-line p-2 lg:block">{properties}</aside>
      </div>

      {merging && <MergeModal issue={issue} repos={repos} onClose={() => setMerging(false)} />}
    </div>
  );
}

const pick = (r?: IssueRepo) => (r ? { baseBranch: r.baseBranch, targetBranch: r.targetBranch } : {});

// Um repositório da issue: base (fixa depois que a IA mexe) → destino do merge.
function IssueRepoRow({ r, repo, locked, onChange }: { r: IssueRepo; repo?: Repo; locked: boolean; onChange: (b: { baseBranch?: string; targetBranch?: string }) => void }) {
  const state = r.mergedInto ? ['mesclado', 'text-sky-400'] : r.conflict ? ['conflito', 'text-red-400'] : r.changed ? ['alterado', 'text-emerald-400'] : null;
  return (
    <div className="ml-24 rounded-md border border-line/70 px-2 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium">{r.name}</span>
        {state && <span className={clsx('ml-auto text-[11px]', state[1])}>{state[0]}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-xs">
        {locked || r.changed || r.mergedInto ? <span className="px-1 font-mono text-[11px] text-mute">{r.baseBranch}</span>
          : <BranchPicker repoId={r.repoId} value={r.baseBranch} onChange={(baseBranch) => onChange({ baseBranch })} />}
        <span className="text-mute">→</span>
        {locked || r.mergedInto ? <span className="px-1 font-mono text-[11px] text-mute">{r.mergedInto || r.targetBranch}</span>
          : <BranchPicker repoId={r.repoId} value={r.targetBranch} protectedBranches={repo?.protectedBranches} onChange={(targetBranch) => onChange({ targetBranch })} />}
      </div>
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-24 shrink-0 px-2 text-xs text-mute">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function TitleEditor({ issue, onSave }: { issue: Issue; onSave: (t: string) => void }) {
  const [value, setValue] = useState(issue.title);
  useEffect(() => setValue(issue.title), [issue.title]);
  return (
    <textarea
      value={value}
      rows={1}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ''))}
      onBlur={() => value.trim() && value !== issue.title && onSave(value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      className="w-full resize-none overflow-hidden text-xl font-semibold leading-snug [field-sizing:content]"
    />
  );
}

function DescriptionEditor({ issue, onSave }: { issue: Issue; onSave: (d: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.description);
  useEffect(() => {
    if (!editing) setValue(issue.description);
  }, [issue.description, editing]);
  if (editing) {
    return (
      <div className="mt-3">
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { onSave(value); setEditing(false); }
          }}
          rows={10}
          className="field-input"
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
          <Button size="sm" variant="primary" onClick={() => { onSave(value); setEditing(false); }}>Salvar</Button>
        </div>
      </div>
    );
  }
  return (
    <div onClick={() => setEditing(true)} className="mt-3 min-h-[40px] cursor-text rounded-md px-1 py-1 hover:bg-hover/40">
      {issue.description ? <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(issue.description) }} /> : <span className="text-mute">Adicionar descrição…</span>}
    </div>
  );
}

// ---------- atividade ----------

type TimelineItem = { at: string; comment?: Comment; run?: Run };

function Activity({ issue, runs, comments }: { issue: Issue; runs: Run[]; comments: Comment[] }) {
  const items = useMemo<TimelineItem[]>(() => {
    const all: TimelineItem[] = [...comments.map((c) => ({ at: c.createdAt, comment: c })), ...runs.map((r) => ({ at: r.createdAt, run: r }))];
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }, [runs, comments]);
  const lastRunId = runs[runs.length - 1]?.id;
  return (
    <div className="space-y-3">
      {items.map((it) =>
        it.run ? <RunCard key={it.run.id} run={it.run} defaultOpen={it.run.id === lastRunId && (it.run.status === 'running' || it.run.status === 'queued')} />
          : <CommentItem key={it.comment!.id} comment={it.comment!} />
      )}
      {!items.length && <p className="text-mute">Sem atividade ainda.</p>}
      <Composer issue={issue} hasRuns={runs.length > 0} />
    </div>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  const { data: users = [] } = useUsers();
  const { data: agents = [] } = useAgents();
  if (comment.kind === 'system') {
    return <div className="flex gap-2 px-1 text-xs text-mute"><span>•</span><div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }} /> <span className="ml-auto shrink-0">{timeAgo(comment.createdAt)}</span></div>;
  }
  const user = users.find((u) => u.id === comment.userId);
  const agent = agents.find((a) => a.id === comment.agentId);
  return (
    <div className={clsx('rounded-xl border p-3.5', comment.kind === 'agent' ? 'border-accent/25 bg-gradient-to-b from-accent/[0.08] to-accent/[0.02]' : 'border-white/[0.07] bg-card/60')}>
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        {agent ? <AgentIcon avatar={agent.avatar} /> : <Avatar name={user?.name} />}
        <span className="font-medium">{agent?.name ?? user?.name ?? 'alguém'}</span>
        <span className="text-mute">{timeAgo(comment.createdAt)}</span>
      </div>
      <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }} />
    </div>
  );
}

const RUN_LABEL: Record<Run['kind'], string> = { initial: 'Execução', followup: 'Ajuste', conflict: 'Resolução de conflito' };
const RUN_STATUS: Record<Run['status'], [string, string]> = {
  queued: ['na fila', 'text-sky-400'],
  running: ['rodando', 'text-amber-400'],
  succeeded: ['concluída', 'text-emerald-400'],
  failed: ['falhou', 'text-red-400'],
  cancelled: ['cancelada', 'text-mute']
};

function RunCard({ run, defaultOpen }: { run: Run; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const [label, color] = RUN_STATUS[run.status];
  const secs = runSeconds(run);
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs transition-colors hover:bg-white/[0.03]">
        {open ? <ChevronDown className="size-3.5 text-mute" /> : <ChevronRight className="size-3.5 text-mute" />}
        <span className="grid size-5 place-items-center rounded-md bg-accent/15"><Wand2 className="size-3 text-accent" /></span>
        <span className="font-medium">{RUN_LABEL[run.kind]}</span>
        <span className="text-mute">· {run.agentName}{run.model ? ` (${run.model})` : ''}</span>
        <span className={clsx('flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5', color)}>
          {(run.status === 'running' || run.status === 'queued') && <span className="size-1.5 animate-pulse-soft rounded-full bg-current" />} {label}
        </span>
        <span className="ml-auto hidden gap-2 text-mute sm:flex">
          {secs != null && <span>{duration(secs)}</span>}
          {run.costUsd > 0 && <span>{money(run.costUsd)}</span>}
          {run.commitSha && <span className="font-mono">{run.commitSha}</span>}
        </span>
      </button>
      {run.request && <div className="border-t border-line bg-card px-3 py-2 text-xs text-dim"><span className="text-mute">Pedido: </span>{run.request}</div>}
      {open && <RunLog run={run} />}
      {run.error && !open && <div className="border-t border-line px-3 py-1.5 text-xs text-red-400">{run.error}</div>}
    </div>
  );
}

function RunLog({ run }: { run: Run }) {
  const { data: events, isLoading } = useQuery({
    queryKey: ['events', run.id],
    queryFn: () => api.get<RunEvent[]>(`/runs/${run.id}/events`),
    staleTime: run.status === 'running' ? Infinity : 60_000
  });
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events?.length]);
  const [showPrompt, setShowPrompt] = useState(false);
  if (isLoading) return <div className="p-3"><Spinner /></div>;
  const prompt = events?.find((e) => e.kind === 'prompt');
  return (
    <div className="border-t border-line bg-bg">
      {prompt && (
        <button onClick={() => setShowPrompt(!showPrompt)} className="w-full px-3 py-1.5 text-left text-[11px] text-mute hover:text-fg">
          {showPrompt ? '▾' : '▸'} Contexto enviado ao agente
        </button>
      )}
      {showPrompt && prompt && <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-y border-line px-3 py-2 font-mono text-[11px] text-dim">{prompt.body}</pre>}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[60vh] overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed"
      >
        {events?.filter((e) => e.kind !== 'prompt').map((e) => <LogLine key={e.id} ev={e} />)}
        {!events?.length && <div className="text-mute">{run.status === 'queued' ? 'Aguardando uma vaga…' : 'Sem eventos.'}</div>}
      </div>
    </div>
  );
}

function LogLine({ ev }: { ev: RunEvent }) {
  switch (ev.kind) {
    case 'text':
      return <div className="markdown my-2 font-sans text-[13px] text-fg" dangerouslySetInnerHTML={{ __html: renderMarkdown(ev.body) }} />;
    case 'tool':
      return <div className="truncate text-accent">› {ev.body}</div>;
    case 'out':
      return <div className="line-clamp-4 whitespace-pre-wrap break-words text-mute">{ev.body}</div>;
    case 'error':
      return <div className="whitespace-pre-wrap break-words text-red-400">{ev.body}</div>;
    case 'result':
      return <div className="mt-2 border-t border-line pt-1.5 text-emerald-400">{ev.body}</div>;
    default:
      return <div className="text-sky-400/80">{ev.body}</div>;
  }
}

function Composer({ issue, hasRuns }: { issue: Issue; hasRuns: boolean }) {
  const [body, setBody] = useState('');
  const [agentId, setAgentId] = useState<string | null>(issue.agentId);
  const canRun = useCan('issue.run');
  const [send, setSend] = useState(canRun && !!issue.agentId && issue.status !== 'backlog');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => setAgentId(issue.agentId), [issue.agentId]);
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ warning?: string }>(`/issues/${issue.id}/comments`, { body, sendToAgent: send && !!agentId, agentId: agentId ?? '' });
      if (res.warning) toast('error', res.warning);
      else if (send && agentId) toast('success', hasRuns ? 'Ajuste enviado ao agente' : 'Enviado ao agente');
      setBody('');
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-white/[0.08] bg-card/60 p-2.5 transition focus-within:border-accent/50 focus-within:shadow-[0_0_0_3px_rgb(var(--accent)/0.12)]">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
        rows={3}
        placeholder={send && agentId ? 'Peça um ajuste: vai num chat novo junto com o resumo e os commits da branch…' : 'Comentário…'}
        className="w-full resize-y px-1 leading-relaxed placeholder:text-mute"
      />
      <div className="flex flex-wrap items-center gap-2">
        {canRun && <Toggle checked={send} onChange={setSend} label="Enviar para o agente" />}
        {send && <AgentPicker value={agentId} onChange={setAgentId} allowNone={false} />}
        <Button size="sm" variant="primary" className="ml-auto" loading={busy} onClick={submit}><Send className="size-3.5" /> {send && agentId ? 'Enviar' : 'Comentar'}</Button>
      </div>
    </div>
  );
}

// ---------- resumo, diff, execuções, merge ----------

function SummaryTab({ issue, onSave }: { issue: Issue; onSave: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.summary);
  useEffect(() => {
    if (!editing) setValue(issue.summary);
  }, [issue.summary, editing]);
  return (
    <div>
      <p className="mb-3 text-xs text-mute">O agente reescreve este resumo ao fim de cada execução, e ele é o contexto da próxima, que sempre começa num chat limpo.</p>
      {editing ? (
        <>
          <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={16} className="field-input font-mono text-[12px]" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
            <Button size="sm" variant="primary" onClick={() => { onSave(value); setEditing(false); }}>Salvar</Button>
          </div>
        </>
      ) : (
        <div onClick={() => setEditing(true)} className="cursor-text rounded-xl border border-white/[0.08] bg-card/60 p-4">
          {issue.summary ? <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(issue.summary) }} /> : <span className="text-mute">Ainda sem resumo. Ele aparece depois da primeira execução.</span>}
        </div>
      )}
    </div>
  );
}

function DiffTab({ issue }: { issue: Issue }) {
  const { data = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ['diff', issue.id, issue.updatedAt], queryFn: () => api.get<RepoDiff[]>(`/issues/${issue.id}/diff`) });
  if (isLoading) return <Spinner />;
  const merged = issue.repos.filter((r) => r.mergedInto);
  if (!data.length) {
    return <p className="text-mute">{merged.length ? `Mesclada (${merged.map((r) => `${r.name} → ${r.mergedInto}`).join(', ')}); as branches foram removidas.` : 'Ainda não há alterações.'}</p>;
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-mute">{data.length} repositório(s) alterado(s)</span>
        <Button size="sm" variant="ghost" className="ml-auto" loading={isFetching} onClick={() => refetch()}>Atualizar</Button>
      </div>
      {data.map((d) => <RepoDiffView key={d.repoId} d={d} />)}
    </div>
  );
}

function RepoDiffView({ d }: { d: RepoDiff }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button onClick={() => setOpen(!open)} className="mb-2 flex w-full items-center gap-1.5 text-left font-medium">
        {open ? <ChevronDown className="size-4 text-mute" /> : <ChevronRight className="size-4 text-mute" />} {d.name}
        {d.pending && <span className="text-xs font-normal text-amber-400">· alterações não commitadas</span>}
      </button>
      {open && (
        <div className="space-y-2">
          {d.stat && <pre className="overflow-x-auto rounded-lg border border-line bg-card p-3 font-mono text-[12px] text-dim">{d.stat}</pre>}
          <div className="overflow-x-auto rounded-lg border border-line bg-bg py-1 font-mono text-[12px] leading-relaxed">
            {d.patch.split('\n').map((l, i) => (
              <div
                key={i}
                className={clsx(
                  'whitespace-pre px-3',
                  l.startsWith('diff --git') && 'mt-2 bg-card py-1 font-semibold text-fg',
                  l.startsWith('@@') && 'text-sky-400/80',
                  l.startsWith('+') && !l.startsWith('+++') && 'bg-emerald-500/10 text-emerald-300',
                  l.startsWith('-') && !l.startsWith('---') && 'bg-red-500/10 text-red-300',
                  /^(index |\+\+\+|---|new file|deleted file)/.test(l) && 'text-mute'
                )}
              >
                {l || ' '}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function RunsTable({ runs }: { runs: Run[] }) {
  if (!runs.length) return <p className="text-mute">Nenhuma execução.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-mute">
          <tr className="border-b border-line">
            {['Quando', 'Tipo', 'Agente', 'Status', 'Duração', 'Custo', 'Tokens in / cache / out', 'Commit'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...runs].reverse().map((r) => {
            const secs = runSeconds(r);
            return (
              <tr key={r.id} className="border-b border-line/60">
                <td className="px-2 py-2 text-mute">{timeAgo(r.createdAt)}</td>
                <td className="px-2 py-2">{RUN_LABEL[r.kind]}</td>
                <td className="px-2 py-2">{r.agentName} <span className="text-mute">{r.model}</span></td>
                <td className={clsx('px-2 py-2', RUN_STATUS[r.status][1])}>{RUN_STATUS[r.status][0]}</td>
                <td className="px-2 py-2">{secs != null ? duration(secs) : '—'}</td>
                <td className="px-2 py-2">{r.costUsd ? money(r.costUsd) : '—'}</td>
                <td className="px-2 py-2 font-mono">{compact(r.inputTokens)} / {compact(r.cachedTokens)} / {compact(r.outputTokens)}</td>
                <td className="px-2 py-2 font-mono">{r.commitSha || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MergeModal({ issue, repos, onClose }: { issue: Issue; repos: Repo[]; onClose: () => void }) {
  const pending = issue.repos.filter((r) => r.changed && !r.mergedInto);
  const [targets, setTargets] = useState<Record<string, string>>(() => Object.fromEntries(pending.map((r) => [r.repoId, r.targetBranch])));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const prot = (r: IssueRepo) => !!repos.find((x) => x.id === r.repoId)?.protectedBranches.includes(targets[r.repoId]);
  const blocked = pending.some(prot);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ conflict: boolean; repos: RepoMerge[]; error?: string }>(`/issues/${issue.id}/merge`, { targets });
      if (res.error) toast('error', res.error);
      else if (res.conflict) toast('error', `Conflito em ${res.repos.filter((r) => r.conflict).map((r) => r.name).join(', ')}. Nada foi publicado. Use "Resolver conflito com IA".`);
      else toast('success', `Merge feito: ${res.repos.map((r) => `${r.name} → ${r.target} (${r.sha})`).join(', ')}`);
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={pending.length > 1 ? `Fazer merge em ${pending.length} repositórios` : 'Fazer merge'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="success" loading={busy} disabled={blocked} onClick={submit}><GitMerge className="size-3.5" /> Fazer merge</Button></>}
    >
      <p className="mb-3 text-dim">
        Merge <code className="font-mono text-xs">--no-ff</code> de <code className="font-mono text-xs">{issue.branch}</code> em cada repositório alterado.
        Os merges são feitos primeiro no servidor; se algum der conflito, <b>nada</b> é publicado.
      </p>
      <div className="space-y-2">
        {pending.map((r) => (
          <div key={r.repoId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
            <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
            <span className="text-xs text-mute">→</span>
            <BranchPicker repoId={r.repoId} value={targets[r.repoId]} onChange={(b) => setTargets({ ...targets, [r.repoId]: b })}
              protectedBranches={repos.find((x) => x.id === r.repoId)?.protectedBranches} />
            {prot(r) && <span className="w-full text-xs text-red-400">Branch protegida: o Multica não faz merge nela.</span>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
