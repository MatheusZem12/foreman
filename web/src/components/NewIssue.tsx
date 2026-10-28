import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Maximize2, Minimize2, X } from 'lucide-react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { Button, Toggle, useToast } from './ui';
import { AgentPicker, AssigneePicker, LabelPicker, PriorityPicker, RepoScopePicker, StatusPicker } from './pickers';
import { useWs } from './Layout';
import { useAgents, useCan, useRepos, useRules } from '../lib/queries';
import { api } from '../lib/api';
import { LAST_AGENT, STATUSES } from '../lib/constants';
import type { Issue, Status } from '../lib/types';
import { t } from '../lib/i18n';

function readLastAgent() {
  try {
    return localStorage.getItem(LAST_AGENT);
  } catch {
    return null;
  }
}

// Etapa inicial: a última usada neste workspace, ou a primeira do fluxo.
function lastStage(wsId: string): Status {
  let saved = '';
  try {
    saved = localStorage.getItem(`mx.newStage.${wsId}`) ?? '';
  } catch {
    /* sem storage */
  }
  return STATUSES.some((s) => s.id === saved) ? saved : STATUSES[0]?.id ?? '';
}

export function NewIssueModal({ initialStatus, onClose }: { initialStatus?: Status; onClose: () => void }) {
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: repos = [] } = useRepos(ws.id);
  const canRepos = useCan('repo.create');
  // O perfil define o que quem cria pode escolher (ex.: estagiário cria, mas sem agente).
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

  // Padrão: último agente usado.
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

  // O agente começa se a etapa escolhida tem a regra "rodar agente" ao entrar.
  const { data: rules = [] } = useRules(ws.id);
  const startStages = rules.filter((r) => r.enabled && r.trigger === 'enter' && r.action === 'run_agent').map((r) => r.stage);
  const willStart = !!form.agentId && startStages.includes(form.status);
  useEffect(() => {
    try {
      localStorage.setItem(`mx.newStage.${ws.id}`, form.status);
    } catch {
      /* sem storage */
    }
  }, [form.status, ws.id]);

  const submit = async () => {
    if (!form.title.trim()) return titleRef.current?.focus();
    setBusy(true);
    try {
      const res = await api.post<{ issue: Issue; warning?: string }>(`/workspaces/${ws.id}/issues`, form);
      qc.setQueryData<Issue[]>(['issues', ws.id], (l) => (l && !l.some((i) => i.id === res.issue.id) ? [...l, res.issue] : l));
      if (form.agentId) {
        try {
          localStorage.setItem(LAST_AGENT, form.agentId);
        } catch {
          /* sem storage */
        }
      }
      if (res.warning) toast('error', t('Criada, mas não iniciou: {0}', res.warning));
      else toast('success', t('{0}-{1} criada{2}', ws.key, res.issue.number, willStart ? t(' e na fila do agente') : ''));
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
    <div className="fixed inset-0 z-50 flex animate-[fade_.15s_ease-out] items-end justify-center bg-black/70 backdrop-blur-sm sm:items-start sm:p-6 sm:pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
        className={clsx('flex max-h-[95dvh] w-full animate-[pop_.18s_ease-out] flex-col rounded-t-2xl border border-white/10 bg-panel shadow-pop sm:rounded-2xl', big ? 'sm:h-[80vh] sm:max-w-4xl' : 'sm:max-w-2xl')}
      >
        <div className="flex items-center gap-2 px-6 pt-5 text-xs text-mute">
          <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-medium text-dim">{ws.key}</span><span>›</span><span className="text-dim">{t('Nova issue')}</span>
          <button type="button" onClick={() => setBig(!big)} className="ml-auto hidden rounded p-1 hover:bg-hover sm:block">{big ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</button>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-hover"><X className="size-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-6 pt-3">
          <input ref={titleRef} autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={t('Título da issue')} className="text-xl font-semibold tracking-tight placeholder:text-mute/70" />
          <textarea
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder={t('Descrição: o que fazer, critérios de aceite, links… (markdown)')}
            className={clsx('mt-2 flex-1 resize-none text-[14px] leading-relaxed text-dim placeholder:text-mute/70', big ? 'min-h-[40vh]' : 'min-h-[120px]')}
          />
        </div>
        <div className="px-6 pb-2.5 text-xs text-mute">
          {form.agentId
            ? willStart ? t('Atribuída: o agente começa assim que você criar.') : t('Atribuída: começa quando for para uma etapa que roda o agente.')
            : t('Sem agente: fica como tarefa manual.')}
          {repos.length > 1 && !form.repoIds.length && t(' A IA recebe todos os repositórios e mexe só nos necessários.')}
          {!repos.length && <span className="text-amber-400"> · {canRepos ? t('Cadastre um repositório em Workspace para o agente poder trabalhar.') : t('Este workspace ainda não tem repositório; peça ao administrador.')}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5 px-6 pb-5">
          <StatusPicker value={form.status} onChange={(status) => set({ status })} />
          {may.priority && <PriorityPicker value={form.priority} onChange={(priority) => set({ priority })} />}
          {may.assign && <AssigneePicker ws={ws.id} value={form.assigneeId} onChange={(assigneeId) => set({ assigneeId })} />}
          {may.agent && <AgentPicker value={form.agentId} onChange={(agentId) => set({ agentId })} />}
          {may.labels && <LabelPicker ws={ws.id} value={form.labelIds} onChange={(labelIds) => set({ labelIds })} />}
          {may.repos && repos.length > 1 && <RepoScopePicker ws={ws.id} value={form.repoIds} onChange={(repoIds) => set({ repoIds })} />}
        </div>
        <div className="flex items-center gap-3 rounded-b-2xl border-t border-white/[0.06] bg-black/20 px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Toggle checked={another} onChange={setAnother} label={t('Criar outra')} />
          <Button variant="primary" type="submit" loading={busy} className="ml-auto">
            {t('Criar issue')} <kbd className="hidden rounded-md bg-white/15 px-1.5 py-px font-sans text-[10px] font-medium sm:inline">{t('Ctrl ↵')}</kbd>
          </Button>
        </div>
      </form>
    </div>,
    document.body
  );
}
