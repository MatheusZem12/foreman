import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Maximize2, Minimize2, X } from 'lucide-react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { Button, Toggle, useToast } from './ui';
import { AgentPicker, AssigneePicker, LabelPicker, PriorityPicker, RepoScopePicker, StatusPicker } from './pickers';
import { useWs } from './Layout';
import { useAgents, useCan, useRepos, useRules, useSkills } from '../lib/queries';
import { api } from '../lib/api';
import { LAST_AGENT, STATUSES } from '../lib/constants';
import type { Issue, Status } from '../lib/types';
import { t } from '../lib/i18n';
import { upsertIssue } from '../lib/board';
import { useImageAttach } from './ImageAttach';

function readLastAgent() {
  try {
    return localStorage.getItem(LAST_AGENT);
  } catch {
    return null;
  }
}

// Initial stage: the last one used in this workspace, or the workflow's first.
function lastStage(wsId: string): Status {
  let saved = '';
  try {
    saved = localStorage.getItem(`foreman.newStage.${wsId}`) ?? '';
  } catch {
    /* no storage */
  }
  return STATUSES.some((s) => s.id === saved) ? saved : STATUSES[0]?.id ?? '';
}

export function NewIssueModal({ initialStatus, onClose }: { initialStatus?: Status; onClose: () => void }) {
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: repos = [] } = useRepos(ws.id);
  const canRepos = useCan('repo.create');
  // The role defines what the creator can choose (e.g. an intern creates, but without an agent).
  const may = { agent: useCan('issue.agent'), priority: useCan('issue.priority'), labels: useCan('issue.labels'), repos: useCan('issue.repos'), assign: useCan('issue.assign') };
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const titleRef = useRef<HTMLInputElement>(null);
  const [big, setBig] = useState(false);
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: '', description: '', status: initialStatus || lastStage(ws.id), priority: 0,
    agentId: null as string | null, assigneeId: null as string | null, repoIds: [] as string[], labelIds: [] as string[]
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const descRef = useRef<HTMLTextAreaElement>(null);
  const img = useImageAttach(descRef, (fn) => setForm((f) => ({ ...f, description: fn(f.description) })));

  // Default: the last agent used.
  useEffect(() => {
    if (!form.agentId && agents.length && may.agent) {
      const last = readLastAgent();
      set({ agentId: agents.find((a) => a.id === last)?.id ?? agents[0].id });
    }
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The agent starts if the chosen stage has the "run agent" rule on enter.
  const { data: rules = [] } = useRules(ws.id);
  const startStages = rules.filter((r) => r.enabled && r.trigger === 'enter' && r.action === 'run_agent').map((r) => r.stage);
  const willStart = !!form.agentId && startStages.includes(form.status);

  // The skills that go along with the agent's runs on this issue: the agent's, this
  // workspace's and the chosen labels' (the server resolves the same).
  const { data: skills = [] } = useSkills();
  const agent = agents.find((a) => a.id === form.agentId);
  const byLabel = (s: (typeof skills)[number]) => s.labelIds?.some((id) => form.labelIds.includes(id));
  const sent = agent ? skills.filter((s) => s.always || s.workspaceIds?.includes(ws.id) || agent.skillIds.includes(s.id) || byLabel(s)) : [];
  const why = (s: (typeof skills)[number]) => [
    agent?.skillIds.includes(s.id) && t('the agent'), s.workspaceIds?.includes(ws.id) && t('this workspace'), byLabel(s) && t('a label'), s.always && t('every issue')
  ].filter(Boolean).join(', ');
  useEffect(() => {
    try {
      localStorage.setItem(`foreman.newStage.${ws.id}`, form.status);
    } catch {
      /* no storage */
    }
  }, [form.status, ws.id]);

  const submit = async () => {
    if (!form.title.trim()) return titleRef.current?.focus();
    if (img.uploading) return;
    setBusy(true);
    try {
      const res = await api.post<{ issue: Issue; warning?: string }>(`/workspaces/${ws.id}/issues`, form);
      upsertIssue(qc, ws.id, res.issue);
      if (form.agentId) {
        try {
          localStorage.setItem(LAST_AGENT, form.agentId);
        } catch {
          /* no storage */
        }
      }
      if (res.warning) toast('error', t('Created, but didn\'t start: {0}', res.warning));
      else toast('success', t('{0}-{1} created{2}', ws.key, res.issue.number, willStart ? t(' and queued for the agent') : ''));
      if (another) {
        set({ title: '', description: '' });
        titleRef.current?.focus();
      } else {
        onClose();
        if (big) nav(`/w/${ws.key}/issues/${ws.key}-${res.issue.number}`);
      }
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex animate-[fade_.15s_ease-out] items-end justify-center bg-black/60 sm:items-start sm:p-6 sm:pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
        className={clsx('flex max-h-[95dvh] w-full animate-[sheet_.2s_ease-out] flex-col rounded-t-2xl border border-line bg-panel shadow-pop sm:animate-[pop_.16s_ease-out] sm:rounded-xl', big ? 'sm:h-[80vh] sm:max-w-4xl' : 'sm:max-w-2xl')}
      >
        <div className="flex items-center gap-2 px-5 pt-3 text-xs text-mute sm:px-6 sm:pt-4">
          <span className="badge font-mono">{ws.key}</span><span>›</span><span className="text-dim">{t('New issue')}</span>
          <button type="button" onClick={() => setBig(!big)} aria-label={big ? t('Smaller') : t('Larger')} className="icon-btn ml-auto hidden size-7 sm:grid">{big ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</button>
          <button type="button" onClick={onClose} aria-label={t('Close')} className="icon-btn ml-auto size-7 sm:ml-0"><X className="size-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-2 sm:px-6">
          <input ref={titleRef} autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={t('Issue title')} className="keep-size text-xl font-semibold tracking-tight placeholder:text-mute/70" />
          <textarea
            ref={descRef}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            {...img.textareaProps}
            placeholder={t('Description: what to do, acceptance criteria, links, images (paste or drop them here)… (markdown)')}
            className={clsx('mt-2 flex-1 resize-none text-[14px] leading-relaxed text-dim placeholder:text-mute/70', big ? 'min-h-[40vh]' : 'min-h-[120px]')}
          />
        </div>
        <div className="px-5 pb-2.5 pt-2 text-xs leading-relaxed text-mute sm:px-6">
          {form.agentId
            ? willStart ? t('Assigned: the agent starts as soon as you create it.') : t('Assigned: starts when moved to a stage that runs the agent.')
            : t('No agent: stays a manual task.')}
          {repos.length > 1 && !form.repoIds.length && t(' The AI gets every repository and only touches the ones it needs.')}
          {!repos.length && <span className="text-amber-400"> · {canRepos ? t('Add a repository under Workspace so the agent can work.') : t('This workspace has no repository yet; ask an administrator.')}</span>}
        </div>
        {agent && (
          <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2.5 text-xs sm:px-6">
            <span className="inline-flex items-center gap-1 text-mute"><BookOpen className="size-3.5" /> {sent.length ? t('Skills sent to {0}:', agent.name) : t('No skills go to {0}.', agent.name)}</span>
            {sent.map((s) => <span key={s.id} className="badge" title={`${why(s)}${s.description ? ` · ${s.description}` : ''}`}>{s.name}</span>)}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 px-5 pb-4 sm:px-6">
          <StatusPicker value={form.status} onChange={(status) => set({ status })} />
          {may.priority && <PriorityPicker value={form.priority} onChange={(priority) => set({ priority })} />}
          {may.assign && <AssigneePicker ws={ws.id} value={form.assigneeId} onChange={(assigneeId) => set({ assigneeId })} />}
          {may.agent && <AgentPicker value={form.agentId} onChange={(agentId) => set({ agentId })} />}
          {may.labels && <LabelPicker ws={ws.id} value={form.labelIds} onChange={(labelIds) => set({ labelIds })} />}
          {may.repos && repos.length > 1 && <RepoScopePicker ws={ws.id} value={form.repoIds} onChange={(repoIds) => set({ repoIds })} />}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <Toggle checked={another} onChange={setAnother} label={t('Create another')} />
          {img.button}
          <Button variant="primary" type="submit" loading={busy} disabled={img.uploading} className="ml-auto">
            {t('Create issue')} <kbd className="hidden rounded bg-snow/20 px-1 py-px font-sans text-[10px] font-medium sm:inline">{t('Ctrl ↵')}</kbd>
          </Button>
        </div>
      </form>
    </div>,
    document.body
  );
}
