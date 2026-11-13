import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, CircleStop, GitMerge, Hand, Lock, MoreHorizontal, Play, Send, SlidersHorizontal, Swords, Trash2, Undo2
} from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, Button, Empty, MenuItem, Modal, PageLoader, Popover, Spinner, StatusIcon, Tabs, Toggle, useToast, useConfirm } from '../components/ui';
import { AgentPicker, AssigneePicker, BranchPicker, LabelPicker, PriorityPicker, RepoScopePicker, StatusPicker } from '../components/pickers';
import { api } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { compact, duration, money, runSeconds, timeAgo } from '../lib/format';
import { useAgents, useCan, useUsers } from '../lib/queries';
import { statusOf } from '../lib/constants';
import type { Comment, Issue, IssueDetail, IssueRepo, RepoDiff, RepoMerge, Run, RunEvent } from '../lib/types';
import { AgentIcon } from '../components/AgentIcon';
import { locale, t } from '../lib/i18n';
import { upsertIssue } from '../lib/board';
import { useImageAttach } from '../components/ImageAttach';

type Tab = 'activity' | 'summary' | 'diff' | 'runs';

export function IssuePage() {
  const { ref } = useParams();
  const { ws } = useWs();
  const { data, isLoading, error } = useQuery({ queryKey: ['issue-ref', ref], queryFn: () => api.get<IssueDetail>(`/issues/${ref}`) });
  // The page uses the key by id (which real time updates); the search by "LING-12" only resolves the id.
  const id = data?.issue.id;
  const detail = useQuery({
    queryKey: ['issue', id],
    queryFn: () => api.get<IssueDetail>(`/issues/${id}`),
    enabled: !!id,
    initialData: data,
    initialDataUpdatedAt: () => Date.now()
  });

  if (isLoading) return <PageLoader />;
  if (error || !detail.data) return <Empty>{t('Issue not found.')} <Link className="text-accent" to={`/w/${ws.key}`}>{t('Back')}</Link></Empty>;
  return <IssueView detail={detail.data} />;
}

function patchCache(qc: ReturnType<typeof useQueryClient>, issue: Issue) {
  qc.setQueryData<IssueDetail>(['issue', issue.id], (d) => (d ? { ...d, issue } : d));
  upsertIssue(qc, issue.workspaceId, issue);
}

function IssueView({ detail }: { detail: IssueDetail }) {
  const ask = useConfirm();
  const { issue, runs, comments } = detail;
  // What this person can do here: role permission + the current stage's policy.
  const caps = detail.caps;
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const canEdit = caps.repos;
  const canRun = caps.run;
  const canMerge = caps.merge;
  const canDelete = caps.delete;
  const [tab, setTab] = useState<Tab>('activity');
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

  // Scope: every repository (the AI chooses) or only the chosen ones, each with base → target.
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
  // Closed by the stage's "Close" rule; waiting for someone per what the AI declared.
  const closed = !!issue.closed;
  const lastRun = runs[runs.length - 1];
  const needsYou = !active && !closed && (lastRun?.outcome === 'waiting' || lastRun?.outcome === 'incomplete');
  const conflict = issue.repos.some((r) => r.conflict);

  const properties = (
    <div className="space-y-0.5">
      {caps.reason && <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-white/[0.05] px-2.5 py-2 text-[11px] leading-snug text-mute"><Lock className="mt-px size-3 shrink-0" /> {caps.reason}</div>}
      <PropRow label={t('Status')}><Gate on={caps.move}><StatusPicker variant="row" value={issue.status} onChange={(status) => patch({ status })} /></Gate></PropRow>
      <PropRow label={t('Assignee')}><Gate on={caps.assign}><AssigneePicker variant="row" ws={ws.id} value={issue.assigneeId} onChange={(assigneeId) => patch({ assigneeId })} /></Gate></PropRow>
      <PropRow label={t('Priority')}><Gate on={caps.priority}><PriorityPicker variant="row" value={issue.priority} onChange={(priority) => patch({ priority })} /></Gate></PropRow>
      <PropRow label={t('Agent')}><Gate on={caps.agent}><AgentPicker variant="row" value={issue.agentId} onChange={(agentId) => patch({ agentId })} /></Gate></PropRow>
      <PropRow label={t('Labels')}><Gate on={caps.labels}><LabelPicker variant="row" ws={ws.id} value={issue.labelIds} onChange={(labelIds) => patch({ labelIds })} /></Gate></PropRow>
      <PropRow label={t('Repositories')}>
        <Gate on={caps.repos}><RepoScopePicker variant="row" ws={ws.id} value={issue.allRepos ? [] : issue.repos.map((r) => r.repoId)}
          onChange={(ids) => saveRepos(!ids.length, ids.map((repoId) => ({ repoId, ...pick(issue.repos.find((r) => r.repoId === repoId)) })))} /></Gate>
      </PropRow>
      {issue.repos.map((r) => <IssueRepoRow key={r.repoId} r={r} locked={!canEdit || closed} onChange={(b) => setBranch(r.repoId, b)} />)}
      <div className="mt-3 space-y-1 border-t border-line px-2 pt-3 text-xs text-mute">
        {issue.branch && <div className="truncate font-mono text-[11px]" title={issue.branch}>{issue.branch}</div>}
        <div>{t('Total cost:')} <span className="text-dim">{money(issue.costUsd)}</span> · {runs.length} {t('run(s)')}</div>
        <div>{t('Created')} {timeAgo(issue.createdAt)} {t('· updated')} {timeAgo(issue.updatedAt)}</div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="toolbar">
        <button onClick={() => nav(`/w/${ws.key}`)} aria-label={t('Back')} className="icon-btn -ml-1"><ArrowLeft className="size-4" /></button>
        <span className="font-mono text-xs text-dim">{ws.key}-{issue.number}</span>
        <span className="hidden items-center gap-1.5 text-xs text-dim sm:flex"><StatusIcon status={issue.status} /> {statusOf(issue.status).label}</span>
        <span className="sm:hidden"><StatusIcon status={issue.status} /></span>
        {active && <span className="flex items-center gap-1 text-xs text-amber-400"><span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /> {t('working')}</span>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {active && canRun && <Button size="sm" variant="danger" onClick={() => act(() => api.post(`/issues/${issue.id}/cancel`))}><CircleStop className="size-3.5" /> {t('Stop')}</Button>}
          {canRun && !active && !closed && !runs.length && issue.agentId && (
            <Button size="sm" variant="primary" onClick={() => act(() => api.post(`/issues/${issue.id}/run`, { kind: 'initial' }), t('Queued for the agent'))}><Play className="size-3.5" /> {t('Run')}</Button>
          )}
          {canRun && !active && !closed && lastRun?.status === 'failed' && (
            <Button size="sm" onClick={() => act(() => api.post(`/issues/${issue.id}/run`, { kind: lastRun.kind, request: lastRun.request }), t('Queued again'))}><Undo2 className="size-3.5" /> {t('Try again')}</Button>
          )}
          {canRun && conflict && !active && (
            <Button size="sm" variant="outline" onClick={() => act(() => api.post(`/issues/${issue.id}/run`, { kind: 'conflict' }), t('AI resolving the conflict'))}><Swords className="size-3.5" /> {t('Resolve conflict with AI')}</Button>
          )}
          {caps.approvals > 0 && !active && (caps.approve || issue.approvals.length > 0) && (
            <Button size="sm" variant="success" disabled={!caps.approve}
              title={caps.approve ? t('Approve: once it has the required approvals the issue moves on and the destination stage\'s rules run') : t('You already approved, or you can\'t approve in this stage')}
              onClick={() => act(() => api.post(`/issues/${issue.id}/approve`), t('Approval recorded'))}>
              <Check className="size-3.5" /> {t('Approve')}{caps.approvals > 1 && <span className="opacity-80"> {issue.approvals.length}/{caps.approvals}</span>}
            </Button>
          )}
          {canMerge && !active && !closed && hasCommits && !conflict && caps.approvals === 0 && !needsYou && (
            <Button size="sm" variant="success" onClick={() => setMerging(true)}>
              <GitMerge className="size-3.5" /> {t('Merge')}{pendingRepos.length > 1 ? t(' ({0} repos)', pendingRepos.length) : <span className="hidden sm:inline"> {t('into')} {pendingRepos[0].targetBranch}</span>}
            </Button>
          )}
          <Popover align="right" trigger={() => <button aria-label={t('More actions')} className="icon-btn"><MoreHorizontal className="size-4" /></button>}>
            {(close) => (
              <>
                {canMerge && !active && caps.approvals > 0 && hasCommits && !conflict && (
                  <MenuItem onClick={() => { close(); setMerging(true); }}><GitMerge className="size-4" /> {t('Merge, choosing the branch')}</MenuItem>
                )}
                {canMerge && !closed && hasCommits && (
                  <MenuItem onClick={async () => { close(); if (await ask({ title: t('Discard the changes?'), message: t('Deletes the issue\'s worktree and branch (local and remote).'), confirmText: t('Discard'), danger: true })) act(() => api.post(`/issues/${issue.id}/discard`), t('Discarded')); }}>
                    <Undo2 className="size-4" /> {t('Discard changes')}
                  </MenuItem>
                )}
                {canDelete && <MenuItem danger onClick={async () => {
                  close();
                  if (await ask({ title: t('Delete the issue?'), message: t('Deletes the issue, its history and its branches.'), confirmText: t('Delete'), danger: true })) act(async () => { await api.del(`/issues/${issue.id}`); nav(`/w/${ws.key}`); });
                }}><Trash2 className="size-4" /> {t('Delete issue')}</MenuItem>}
                {!canDelete && !(canMerge && !closed && hasCommits) && <div className="px-2 py-1.5 text-xs text-mute">{t('No actions available.')}</div>}
              </>
            )}
          </Popover>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-4 pb-16 pt-5 md:px-8 md:pt-8">
            <Gate on={caps.edit} block><TitleEditor issue={issue} onSave={(title) => patch({ title })} /></Gate>
            <Gate on={caps.edit} block><DescriptionEditor issue={issue} onSave={(description) => patch({ description })} /></Gate>

            {/* Below a large screen the properties fold into the page. */}
            <div className="mt-4 rounded-xl border border-line lg:hidden">
              <button onClick={() => setShowProps(!showProps)} aria-expanded={showProps} className="flex h-10 w-full items-center gap-2 px-3 text-xs text-dim">
                <SlidersHorizontal className="size-3.5 text-mute" /> {t('Properties')}
                <span className="ml-auto flex min-w-0 items-center gap-1.5 text-mute">
                  {!showProps && <span className="truncate">{statusOf(issue.status).label}</span>}
                  {showProps ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                </span>
              </button>
              {showProps && <div className="border-t border-line p-1.5">{properties}</div>}
            </div>

            {needsYou && <WaitingCard issue={issue} lastRun={lastRun} />}

            <Tabs<Tab>
              className="mt-6"
              items={[{ id: 'activity', label: t('Activity') }, { id: 'summary', label: 'README' }, { id: 'diff', label: t('Diff') }, { id: 'runs', label: t('Runs') }]}
              value={tab}
              onChange={setTab}
            />
            <div className="pt-5">
              {tab === 'activity' && <Activity issue={issue} runs={runs} comments={comments} canComment={caps.comment} />}
              {tab === 'summary' && <SummaryTab issue={issue} runs={runs} onSave={(summary) => patch({ summary })} />}
              {tab === 'diff' && <DiffTab issue={issue} />}
              {tab === 'runs' && <RunsTable runs={runs} />}
            </div>
          </div>
        </div>
        <aside className="hidden w-[19rem] shrink-0 overflow-y-auto border-l border-line p-3 lg:block">{properties}</aside>
      </div>

      {merging && <MergeModal issue={issue} onClose={() => setMerging(false)} />}
    </div>
  );
}

const pick = (r?: IssueRepo) => (r ? { baseBranch: r.baseBranch, targetBranch: r.targetBranch } : {});

// One of the issue's repositories: base (fixed once the AI touches it) → merge target.
function IssueRepoRow({ r, locked, onChange }: { r: IssueRepo; locked: boolean; onChange: (b: { baseBranch?: string; targetBranch?: string }) => void }) {
  const state = r.mergedInto ? [t('merged'), 'text-sky-400'] : r.conflict ? [t('conflict'), 'text-red-400'] : r.changed ? [t('changed'), 'text-emerald-400'] : null;
  return (
    <div className="ml-2 rounded-lg border border-line px-2.5 py-2 sm:ml-24">
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium">{r.name}</span>
        {state && <span className={clsx('ml-auto text-[11px]', state[1])}>{state[0]}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-xs">
        {locked || r.changed || r.mergedInto ? <span className="px-1 font-mono text-[11px] text-mute">{r.baseBranch}</span>
          : <BranchPicker repoId={r.repoId} value={r.baseBranch} placeholder={t('repo default')} onChange={(baseBranch) => onChange({ baseBranch })} />}
        <span className="text-mute">→</span>
        {locked || r.mergedInto ? <span className="px-1 font-mono text-[11px] text-mute">{r.mergedInto || r.targetBranch}</span>
          : <BranchPicker repoId={r.repoId} value={r.targetBranch} placeholder={r.baseBranch || t('repo default')} onChange={(targetBranch) => onChange({ targetBranch })} />}
      </div>
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-1">
      <span className="w-24 shrink-0 px-2 text-xs text-mute">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function TitleEditor({ issue, onSave }: { issue: Issue; onSave: (tt: string) => void }) {
  const [value, setValue] = useState(issue.title);
  useEffect(() => setValue(issue.title), [issue.title]);
  return (
    <textarea
      value={value}
      rows={1}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ''))}
      onBlur={() => value.trim() && value !== issue.title && onSave(value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      aria-label={t('Issue title')}
      className="keep-size w-full resize-none overflow-hidden text-[22px] font-semibold leading-snug tracking-tight [field-sizing:content] md:text-2xl"
    />
  );
}

function DescriptionEditor({ issue, onSave }: { issue: Issue; onSave: (d: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.description);
  const ref = useRef<HTMLTextAreaElement>(null);
  const img = useImageAttach(ref, setValue);
  useEffect(() => {
    if (!editing) setValue(issue.description);
  }, [issue.description, editing]);
  if (editing) {
    return (
      <div className="mt-3">
        <textarea
          ref={ref}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...img.textareaProps}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !img.uploading) { onSave(value); setEditing(false); }
          }}
          rows={10}
          className="field-input min-h-40"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="mr-auto">{img.button}</span>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('Cancel')}</Button>
          <Button size="sm" variant="primary" disabled={img.uploading} onClick={() => { onSave(value); setEditing(false); }}>{t('Save')}</Button>
        </div>
      </div>
    );
  }
  return (
    <div onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) setEditing(true); }} className="-mx-2 mt-2 min-h-10 cursor-text rounded-lg px-2 py-1.5 text-[14px] transition-colors hover:bg-white/[0.03]">
      {issue.description ? <Markdown text={issue.description} /> : <span className="text-mute">{t('Add a description…')}</span>}
    </div>
  );
}

// ---------- atividade ----------

type TimelineItem = { at: string; comment?: Comment; run?: Run };

function Activity({ issue, runs, comments, canComment }: { issue: Issue; runs: Run[]; comments: Comment[]; canComment: boolean }) {
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
      {!items.length && <p className="text-mute">{t('No activity yet.')}</p>}
      {canComment && <Composer issue={issue} hasRuns={runs.length > 0} />}
    </div>
  );
}

const CommentItem = memo(function CommentItem({ comment }: { comment: Comment }) {
  const { data: users = [] } = useUsers();
  const { data: agents = [] } = useAgents();
  if (comment.kind === 'system') {
    return (
      <div className="flex items-start gap-2.5 px-1 text-xs text-mute">
        <span className="mt-[7px] size-1 shrink-0 rounded-full bg-mute/70" />
        <Markdown text={comment.body} className="min-w-0 flex-1" />
        <span className="shrink-0">{timeAgo(comment.createdAt)}</span>
      </div>
    );
  }
  const user = users.find((u) => u.id === comment.userId);
  const agent = agents.find((a) => a.id === comment.agentId);
  return (
    <div className={clsx('rounded-xl border p-3.5', comment.kind === 'agent' ? 'border-accent/25 bg-accent/[0.04]' : 'border-line bg-panel')}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        {agent ? <AgentIcon avatar={agent.avatar} /> : <Avatar name={user?.name} />}
        <span className="font-medium">{agent?.name ?? user?.name ?? t('someone')}</span>
        <span className="text-mute">{timeAgo(comment.createdAt)}</span>
      </div>
      <Markdown text={comment.body} />
    </div>
  );
});

const RUN_LABEL: Record<Run['kind'], string> = { initial: t('Run'), followup: t('Adjustment'), conflict: t('Conflict resolution') };
const RUN_STATUS: Record<Run['status'], [string, string]> = {
  queued: [t('queued'), 'text-sky-400'],
  running: [t('running'), 'text-amber-400'],
  succeeded: [t('done'), 'text-emerald-400'],
  failed: [t('failed'), 'text-red-400'],
  cancelled: [t('stopped'), 'text-mute']
};

const RunCard = memo(function RunCard({ run, defaultOpen }: { run: Run; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const [label, color] = RUN_STATUS[run.status];
  const live = run.status === 'running' || run.status === 'queued';
  const secs = runSeconds(run);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-10 w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-xs transition-colors hover:bg-white/[0.03]">
        {open ? <ChevronDown className="size-3.5 shrink-0 text-mute" /> : <ChevronRight className="size-3.5 shrink-0 text-mute" />}
        <span className="font-medium">{RUN_LABEL[run.kind]}</span>
        <span className="min-w-0 truncate text-mute">{run.agentName}{run.model ? ` · ${run.model}` : ''}</span>
        <span className={clsx('flex shrink-0 items-center gap-1.5', color)}>
          <span className={clsx('size-1.5 rounded-full bg-current', live && 'animate-pulse-soft')} /> {label}
        </span>
        <span className="ml-auto hidden shrink-0 gap-3 tabular-nums text-mute sm:flex">
          {secs != null && <span>{duration(secs)}</span>}
          {run.costUsd > 0 && <span>{money(run.costUsd)}</span>}
          {run.commitSha && <span className="font-mono">{run.commitSha}</span>}
        </span>
      </button>
      {run.request && <div className="border-t border-line px-3.5 py-2 text-xs leading-relaxed text-dim"><span className="text-mute">{t('Request:')} </span>{run.request}</div>}
      {open && <RunLog run={run} />}
      {run.error && !open && <div className="border-t border-line px-3.5 py-2 text-xs text-red-400">{run.error}</div>}
    </div>
  );
});

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
  const { prompt, lines } = useMemo(() => ({
    prompt: events?.find((e) => e.kind === 'prompt'),
    lines: events?.filter((e) => e.kind !== 'prompt') ?? []
  }), [events]);
  if (isLoading) return <div className="border-t border-line p-3"><Spinner /></div>;
  return (
    <div className="border-t border-line bg-bg">
      {prompt && (
        <button onClick={() => setShowPrompt(!showPrompt)} aria-expanded={showPrompt} className="flex w-full items-center gap-1 px-3.5 py-2 text-left text-[11px] text-mute transition-colors hover:text-fg">
          {showPrompt ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} {t('Context sent to the agent')}
        </button>
      )}
      {showPrompt && prompt && <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-y border-line px-3.5 py-2 font-mono text-[11px] text-dim">{prompt.body}</pre>}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[60dvh] overflow-y-auto overscroll-contain px-3.5 py-2.5 font-mono text-[12px] leading-relaxed"
      >
        {lines.map((e) => <LogLine key={e.id} ev={e} />)}
        {!lines.length && <div className="text-mute">{run.status === 'queued' ? t('Waiting for a free slot…') : t('No events.')}</div>}
      </div>
    </div>
  );
}

// One line of the agent's log. Memoized: a new line arriving re-renders only itself.
const LogLine = memo(function LogLine({ ev }: { ev: RunEvent }) {
  switch (ev.kind) {
    case 'text':
      return <Markdown text={ev.body} className="my-2 font-sans text-[13px] text-fg" />;
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
});

function Composer({ issue, hasRuns }: { issue: Issue; hasRuns: boolean }) {
  const [body, setBody] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const img = useImageAttach(ref, setBody);
  const [agentId, setAgentId] = useState<string | null>(issue.agentId);
  const canRun = useCan('issue.run');
  const [send, setSend] = useState(canRun && !!issue.agentId && !issue.closed);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => setAgentId(issue.agentId), [issue.agentId]);
  const submit = async () => {
    if (!body.trim() || img.uploading) return;
    setBusy(true);
    try {
      const res = await api.post<{ warning?: string }>(`/issues/${issue.id}/comments`, { body, sendToAgent: send && !!agentId, agentId: agentId ?? '' });
      if (res.warning) toast('error', res.warning);
      else if (send && agentId) toast('success', hasRuns ? t('Adjustment sent to the agent') : t('Sent to the agent'));
      setBody('');
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-line bg-panel p-2.5 transition-colors focus-within:border-accent">
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        {...img.textareaProps}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
        rows={3}
        placeholder={send && agentId ? t('Ask for an adjustment: it goes to a new chat along with the summary and the branch commits…') : t('Comment…')}
        className="w-full resize-y px-1.5 pt-1 leading-relaxed placeholder:text-mute"
      />
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {canRun && <Toggle checked={send} onChange={setSend} label={t('Send to the agent')} />}
        {img.button}
        {send && <AgentPicker value={agentId} onChange={setAgentId} allowNone={false} />}
        <Button size="sm" variant="primary" className="ml-auto" loading={busy} disabled={img.uploading} onClick={submit}><Send className="size-3.5" /> {send && agentId ? t('Send') : t('Comment')}</Button>
      </div>
    </div>
  );
}

// ---------- summary, diff, runs, merge ----------

function SummaryTab({ issue, runs, onSave }: { issue: Issue; runs: Run[]; onSave: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.summary);
  useEffect(() => {
    if (!editing) setValue(issue.summary);
  }, [issue.summary, editing]);
  return (
    <div>
      <p className="mb-3 text-xs text-mute">{t('The record of what was done. The agent rewrites the README at the end of every run; it and the history below are attached to the next chat, which always starts clean.')}</p>
      {editing ? (
        <>
          <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={16} className="field-input font-mono text-[12px]" />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('Cancel')}</Button>
            <Button size="sm" variant="primary" onClick={() => { onSave(value); setEditing(false); }}>{t('Save')}</Button>
          </div>
        </>
      ) : (
        <div onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) setEditing(true); }} className="cursor-text rounded-xl border border-line bg-panel p-4 transition-colors hover:border-white/20">
          {issue.summary ? <Markdown text={issue.summary} /> : <span className="text-mute">{t('No README yet. It shows up after the first run.')}</span>}
        </div>
      )}
      {runs.some((r) => r.status !== 'queued' && r.status !== 'running') && (
        <div className="mt-6">
          <div className="mb-2 text-xs font-medium text-dim">{t('Request history')}</div>
          <ol className="relative space-y-3 border-l border-line pl-4">
            {runs.filter((r) => r.status !== 'queued' && r.status !== 'running').map((r) => {
              const [label, color] = runResult(r);
              return (
                <li key={r.id} className="relative text-[13px]">
                  <span className={clsx('absolute -left-[21px] top-1.5 size-2 rounded-full ring-4 ring-bg', color.replace('text-', 'bg-'))} />
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-mute">
                    <span>{new Date(r.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <span>· {r.agentName} · {RUN_LABEL[r.kind].toLowerCase()}</span>
                    <span className={clsx('font-medium', color)}>· {label}</span>
                  </div>
                  {r.request && <div className="mt-0.5 text-dim">“{r.request}”</div>}
                  {(r.outcomeNote || (r.status === 'failed' && r.error)) && <div className="mt-0.5 text-xs text-mute">{r.outcomeNote || r.error}</div>}
                  {r.commitSha && <div className="mt-0.5 font-mono text-[11px] text-mute">{r.commitSha}</div>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

// A run's outcome: what the AI declared, or the technical status.
function runResult(r: Run): [string, string] {
  if (r.status === 'succeeded') {
    if (r.outcome === 'waiting') return [t('waiting for you'), 'text-orange-400'];
    if (r.outcome === 'incomplete') return [t('incomplete'), 'text-orange-400'];
    return [t('done'), 'text-emerald-400'];
  }
  return RUN_STATUS[r.status];
}

// The AI stopped and needs someone: shows what it asked for and lets you reply right away.
function WaitingCard({ issue, lastRun }: { issue: Issue; lastRun?: Run }) {
  const [reply, setReply] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const img = useImageAttach(ref, setReply);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const canRun = useCan('issue.run');
  const send = async () => {
    if (!reply.trim() || img.uploading) return;
    setBusy(true);
    try {
      const res = await api.post<{ warning?: string }>(`/issues/${issue.id}/comments`, { body: reply, sendToAgent: true, agentId: issue.agentId ?? '' });
      if (res.warning) toast('error', res.warning);
      else toast('success', t('Reply sent: the agent continues in a new chat'));
      setReply('');
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 rounded-xl border border-orange-400/30 bg-orange-400/[0.06] p-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-orange-200">
        <Hand className="size-4 text-orange-400" />
        {lastRun?.outcome === 'incomplete' ? t('The AI couldn\'t finish') : t('The AI needs you')}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-dim">{lastRun?.outcomeNote || t('See the agent\'s last comment.')}</p>
      {canRun && issue.agentId && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <textarea ref={ref} value={reply} onChange={(e) => setReply(e.target.value)} {...img.textareaProps} rows={2} placeholder={t('Answer or decide here; it goes to the agent to continue…')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}
            className="field-input flex-1 text-[13px]" />
          <div className="flex items-center gap-2 sm:self-end">
            {img.button}
            <Button variant="primary" loading={busy} disabled={img.uploading} onClick={send}><Send className="size-3.5" /> {t('Reply')}</Button>
          </div>
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
    return <p className="text-mute">{merged.length ? t('Merged ({0}); the branches were removed.', merged.map((r) => `${r.name} → ${r.mergedInto}`).join(', ')) : t('No changes yet.')}</p>;
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-mute">{data.length} {t('repository(ies) changed')}</span>
        <Button size="sm" variant="ghost" className="ml-auto" loading={isFetching} onClick={() => refetch()}>{t('Refresh')}</Button>
      </div>
      {data.map((d) => <RepoDiffView key={d.repoId} d={d} />)}
    </div>
  );
}

// Above this many lines the diff shows only the beginning until asked for the rest
// (a 50 000-line diff would freeze the page for a moment).
const DIFF_LINES = 3000;
const diffClass = (l: string) => clsx(
  'whitespace-pre px-3.5',
  l.startsWith('diff --git') && 'mt-2 border-y border-line bg-panel py-1.5 font-semibold text-fg first:mt-0 first:border-t-0',
  l.startsWith('@@') && 'text-sky-400/80',
  l.startsWith('+') && !l.startsWith('+++') && 'bg-emerald-500/10 text-emerald-300',
  l.startsWith('-') && !l.startsWith('---') && 'bg-red-500/10 text-red-300',
  /^(index |\+\+\+|---|new file|deleted file)/.test(l) && 'text-mute'
);

function RepoDiffView({ d }: { d: RepoDiff }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const lines = useMemo(() => d.patch.split('\n'), [d.patch]);
  const shown = all ? lines : lines.slice(0, DIFF_LINES);
  return (
    <section>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="mb-2 flex w-full items-center gap-1.5 text-left font-medium">
        {open ? <ChevronDown className="size-4 text-mute" /> : <ChevronRight className="size-4 text-mute" />} {d.name}
        {d.pending && <span className="text-xs font-normal text-amber-400">{t('· uncommitted changes')}</span>}
      </button>
      {open && (
        <div className="space-y-2">
          {d.stat && <pre className="overflow-x-auto rounded-lg border border-line bg-panel p-3 font-mono text-[12px] text-dim">{d.stat}</pre>}
          <div className="overflow-x-auto rounded-lg border border-line bg-bg font-mono text-[12px] leading-relaxed">
            <div className="w-max min-w-full py-1">
              {shown.map((l, i) => <div key={i} className={diffClass(l)}>{l || ' '}</div>)}
            </div>
          </div>
          {!all && lines.length > DIFF_LINES && (
            <Button size="sm" onClick={() => setAll(true)}>{t('Show all {0} lines', lines.length)}</Button>
          )}
        </div>
      )}
    </section>
  );
}

function RunsTable({ runs }: { runs: Run[] }) {
  if (!runs.length) return <p className="text-mute">{t('No runs.')}</p>;
  return (
    <div className="surface overflow-x-auto">
      <table className="w-full whitespace-nowrap text-left text-xs tabular-nums">
        <thead className="text-mute">
          <tr className="border-b border-line">
            {[t('When'), t('Type'), t('Agent'), t('Result'), t('Duration'), t('Cost'), t('Tokens in / cache / out'), t('Commit')].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...runs].reverse().map((r) => {
            const secs = runSeconds(r);
            return (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className="px-3 py-2.5 text-mute">{timeAgo(r.createdAt)}</td>
                <td className="px-3 py-2.5">{RUN_LABEL[r.kind]}</td>
                <td className="px-3 py-2.5">{r.agentName} <span className="text-mute">{r.model}</span></td>
                <td className={clsx('px-3 py-2.5', runResult(r)[1])} title={r.outcomeNote || r.error}>{runResult(r)[0]}</td>
                <td className="px-3 py-2.5">{secs != null ? duration(secs) : '—'}</td>
                <td className="px-3 py-2.5">{r.costUsd ? money(r.costUsd) : '—'}</td>
                <td className="px-3 py-2.5 font-mono">{compact(r.inputTokens)} / {compact(r.cachedTokens)} / {compact(r.outputTokens)}</td>
                <td className="px-3 py-2.5 font-mono">{r.commitSha || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MergeModal({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const pending = issue.repos.filter((r) => r.changed && !r.mergedInto);
  const [targets, setTargets] = useState<Record<string, string>>(() => Object.fromEntries(pending.map((r) => [r.repoId, r.targetBranch])));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ conflict: boolean; repos: RepoMerge[]; error?: string }>(`/issues/${issue.id}/merge`, { targets });
      if (res.error) toast('error', res.error);
      else if (res.conflict) toast('error', t('Conflict in {0}. Nothing was published. Use "Resolve conflict with AI".', res.repos.filter((r) => r.conflict).map((r) => r.name).join(', ')));
      else toast('success', t('Merged: {0}', res.repos.map((r) => `${r.name} → ${r.target} (${r.sha})`).join(', ')));
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
      title={pending.length > 1 ? t('Merge {0} repositories', pending.length) : t('Merge')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button variant="success" loading={busy} onClick={submit}><GitMerge className="size-3.5" /> {t('Merge')}</Button></>}
    >
      <p className="mb-3 text-dim">
        {t('Merge')} <code className="font-mono text-xs">{t('--no-ff')}</code> {t('of')} <code className="font-mono text-xs">{issue.branch}</code> {t('in every changed repository. Merges happen on the server first; if any conflicts,')} <b>{t('nothing')}</b> {t('is published.')}
      </p>
      <div className="space-y-2">
        {pending.map((r) => (
          <div key={r.repoId} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
            <span className="text-xs text-mute">→</span>
            <BranchPicker repoId={r.repoId} value={targets[r.repoId]} onChange={(b) => setTargets({ ...targets, [r.repoId]: b })} />
          </div>
        ))}
      </div>
    </Modal>
  );
}

// Gate locks a control when the person can't change it here (the server checks again).
function Gate({ on, block, children }: { on: boolean; block?: boolean; children: React.ReactNode }) {
  if (on) return <>{children}</>;
  return <div className={clsx('pointer-events-none select-none opacity-60', !block && 'w-full')} aria-disabled>{children}</div>;
}
