import { useMemo, useState } from 'react';
import { FlowMap } from './FlowMap';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle, ArrowRightLeft, ListOrdered, Map as MapIcon, Bot, Check, ChevronDown, Copy, Flag, GitMerge, GitPullRequest, GripVertical, Inbox, Lock,
  Mail, MessageSquare, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, SquareTerminal, Tag, Trash2, UserCheck,
  Users, Webhook, Workflow, Zap
} from 'lucide-react';
import { useWs } from '../components/Layout';
import { Button, Field, Modal, PageHeader, Popover, StatusIcon, Toggle, useToast } from '../components/ui';
import { AgentIcon } from '../components/AgentIcon';
import { api } from '../lib/api';
import { PRIORITIES } from '../lib/constants';
import { useAgents, useCan, useLabels, useMembers, useRoles, useRules, useStages, useWorkspaces } from '../lib/queries';
import type {
  LockField, Requirement, Rule, RuleAction, RuleConditions, RuleConfig, RuleTrigger, Stage, StagePolicy, Who, WorkflowWarning
} from '../lib/types';

// ---------- catálogos ----------

const BUILTIN: Record<string, string> = {
  backlog: 'Ideias e tarefas que ainda não rodam.',
  todo: 'Com agente, a issue entra na fila na hora.',
  in_progress: 'O agente está trabalhando. Todo pedido novo vem para cá.',
  waiting: 'A IA parou e precisa de alguém: decisão, acesso, dado ou confirmação.',
  in_review: 'A IA terminou. Quem aprova dá o ✓.',
  blocked: 'A execução falhou ou o merge deu conflito.',
  done: 'Aprovada e entregue.',
  cancelled: 'Interrompida; a execução em andamento para.'
};

const TRIGGERS: { id: RuleTrigger; label: string; stage?: boolean; hint: string }[] = [
  { id: 'enter', label: 'Entrar na etapa', stage: true, hint: 'venha do quadro, do agente ou de outra regra' },
  { id: 'leave', label: 'Sair da etapa', stage: true, hint: 'para qualquer outra' },
  { id: 'stale', label: 'Ficar parada na etapa', stage: true, hint: 'por X horas sem sair dela' },
  { id: 'created', label: 'Issue criada', hint: 'no quadro, por webhook ou e-mail encaminhado' },
  { id: 'commented', label: 'Novo comentário', hint: 'de uma pessoa' },
  { id: 'run_finished', label: 'Execução do agente terminou', hint: 'concluída, aguardando, incompleta ou com falha' },
  { id: 'assigned', label: 'Responsável definido', hint: 'alguém virou dono da issue' },
  { id: 'priority_changed', label: 'Prioridade trocada', hint: 'use a condição para pegar só urgentes' },
  { id: 'cost_over', label: 'Custo passou de um valor', hint: 'soma das execuções em US$' }
];
const triggerOf = (t: RuleTrigger) => TRIGGERS.find((x) => x.id === t) ?? TRIGGERS[0];

const ACTIONS: { id: RuleAction; icon: typeof Mail; label: string; desc: string; group: string }[] = [
  { id: 'notify', icon: Mail, label: 'Notificar por e-mail', desc: 'Responsável, time, admins, perfis ou pessoas.', group: 'Avisar' },
  { id: 'webhook', icon: Webhook, label: 'Webhook', desc: 'Slack, Discord, Teams, n8n…', group: 'Avisar' },
  { id: 'comment', icon: MessageSquare, label: 'Comentar', desc: 'Deixa uma instrução fixa na issue.', group: 'Avisar' },
  { id: 'move', icon: ArrowRightLeft, label: 'Mover para etapa', desc: 'Encaminha a issue.', group: 'Organizar' },
  { id: 'assign', icon: UserCheck, label: 'Definir responsável', desc: 'Fixo, quem criou ou distribuir entre um grupo.', group: 'Organizar' },
  { id: 'set_priority', icon: Flag, label: 'Definir prioridade', desc: 'Ex.: issue de cliente vira urgente.', group: 'Organizar' },
  { id: 'add_label', icon: Tag, label: 'Adicionar label', desc: 'Marca a issue.', group: 'Organizar' },
  { id: 'set_agent', icon: Bot, label: 'Definir agente', desc: 'Escolhe o agente da issue.', group: 'IA e código' },
  { id: 'run_agent', icon: Sparkles, label: 'Rodar agente', desc: 'Revisão por IA, testes, documentação…', group: 'IA e código' },
  { id: 'open_pr', icon: GitPullRequest, label: 'Abrir pull request', desc: 'GitHub, via gh.', group: 'IA e código' },
  { id: 'merge', icon: GitMerge, label: 'Fazer merge', desc: 'Tudo ou nada entre repositórios.', group: 'IA e código' },
  { id: 'script', icon: SquareTerminal, label: 'Rodar script', desc: 'Bash com variáveis MULTICA_*.', group: 'IA e código' }
];
const actionOf = (id: RuleAction) => ACTIONS.find((a) => a.id === id) ?? ACTIONS[0];

const TARGETS: [string, string][] = [
  ['requester', 'Quem pediu (último pedido ao agente)'],
  ['creator', 'Quem criou a issue'],
  ['assignee', 'O responsável pela issue'],
  ['responsible', 'Os responsáveis da etapa'],
  ['team', 'O time (todo o workspace)'],
  ['admins', 'Só administradores'],
  ['roles', 'Perfis escolhidos'],
  ['users', 'Usuários escolhidos']
];

const LOCKS: [LockField, string][] = [
  ['title', 'Título'], ['description', 'Descrição e README'], ['priority', 'Prioridade'], ['labels', 'Labels'],
  ['agent', 'Agente'], ['repos', 'Repositórios'], ['assignee', 'Responsável']
];
const REQUIRES: [Requirement, string][] = [
  ['agent', 'Ter agente'], ['assignee', 'Ter responsável'], ['description', 'Ter descrição'], ['changes', 'Ter alterações de código']
];
const OUTCOMES: [string, string][] = [['done', 'Concluída'], ['waiting', 'Aguardando alguém'], ['incomplete', 'Incompleta'], ['failed', 'Falhou']];

const emptyPolicy = (): StagePolicy => ({ enter: {}, act: {}, approvers: {}, responsible: {} });

// ---------- página ----------

export function WorkflowPage() {
  const { ws } = useWs();
  const { data: stages = [] } = useStages(ws.id);
  const { data: rules = [] } = useRules(ws.id);
  const { data: warningsRaw } = useQuery({ queryKey: ['wf-warnings', ws.id, rules.length, stages.length], queryFn: () => api.get<WorkflowWarning[]>(`/workspaces/${ws.id}/workflow/warnings`) });
  const { data: email } = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<{ enabled: boolean }>('/settings/email') });
  const warnings = warningsRaw ?? [];
  const [editingRule, setEditingRule] = useState<Partial<Rule> | null>(null);
  const [editingStage, setEditingStage] = useState<(Partial<Stage> & { after?: string }) | null>(null);
  const [copying, setCopying] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Só com "Ver o fluxo": tudo em modo leitura.
  const canEdit = useCan('workflow.manage');
  const [view, setView] = useState<'mapa' | 'etapas'>(() => {
    try {
      return (localStorage.getItem('mx.flowView') as 'mapa' | 'etapas') || 'mapa';
    } catch {
      return 'mapa';
    }
  });
  const pickView = (v: 'mapa' | 'etapas') => {
    setView(v);
    try {
      localStorage.setItem('mx.flowView', v);
    } catch {
      /* sem storage */
    }
  };

  const ordered = useMemo(() => (order ? order.map((id) => stages.find((s) => s.id === id)!).filter(Boolean) : stages), [order, stages]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['rules', ws.id] });
    qc.invalidateQueries({ queryKey: ['stages', ws.id] });
    qc.invalidateQueries({ queryKey: ['wf-warnings', ws.id] });
  };
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = ordered.map((s) => s.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrder(next);
    try {
      qc.setQueryData(['stages', ws.id], await api.put<Stage[]>(`/workspaces/${ws.id}/stages/order`, { ids: next }));
      refresh();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setOrder(null);
    }
  };
  const toggle = async (r: Rule) => {
    try {
      await api.put(`/rules/${r.id}`, { ...r, enabled: !r.enabled });
      refresh();
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  const remove = async (r: Rule) => {
    if (!confirm('Remover esta regra?')) return;
    await api.del(`/rules/${r.id}`);
    refresh();
  };
  const removeStage = async (s: Stage) => {
    if (!confirm(`Remover a etapa "${s.name}"? As issues dela voltam para o Backlog e as regras dela são apagadas.`)) return;
    await api.del(`/workspaces/${ws.id}/stages/${s.id}`);
    refresh();
    qc.invalidateQueries({ queryKey: ['issues', ws.id] });
  };
  const newRule = (p: Partial<Rule>) => setEditingRule({ trigger: 'enter', action: 'notify', config: { to: 'requester' }, conditions: {}, enabled: true, name: '', ...p });
  const globalRules = rules.filter((r) => !triggerOf(r.trigger).stage);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4 pb-24 md:p-8">
        <PageHeader
          icon={Workflow}
          title="Fluxo e automações"
          description={`As etapas do quadro, quem pode fazer o quê em cada uma e as regras que rodam sozinhas. As regras de uma etapa rodam de cima para baixo${canEdit ? '; arraste etapas e regras para mudar a ordem' : ''}.`}
          actions={canEdit ? <>
            <Button onClick={() => setCopying(true)}><Copy className="size-4" /> Copiar para…</Button>
            <Button variant="primary" onClick={() => setEditingStage({ color: '#a78bfa', after: 'in_review', policy: emptyPolicy() })}><Plus className="size-4" /> Nova etapa</Button>
          </> : <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-mute">somente leitura</span>}
        />

        {warnings.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-200">
            <div className="mb-1.5 flex items-center gap-2 font-medium"><AlertTriangle className="size-3.5 text-amber-400" /> {warnings.length} ponto(s) para revisar</div>
            <ul className="space-y-0.5 pl-5">
              {warnings.map((w, i) => <li key={i} className="list-disc"><b className="font-medium">{w.where}:</b> {w.message}</li>)}
            </ul>
          </div>
        )}
        {email && !email.enabled && rules.some((r) => r.action === 'notify' && r.enabled) && <EmailOffAlert count={rules.filter((r) => r.action === 'notify' && r.enabled).length} />}

        <div className="mb-4 flex gap-1 border-b border-line">
          {([['mapa', 'Mapa do fluxo', MapIcon], ['etapas', 'Etapas e regras', ListOrdered]] as const).map(([id, label, I]) => (
            <button key={id} onClick={() => pickView(id)}
              className={clsx('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors', view === id ? 'border-accent font-medium text-fg' : 'border-transparent text-mute hover:text-fg')}>
              <I className="size-3.5" /> {label}
            </button>
          ))}
        </div>

        {view === 'mapa' && <FlowMap stages={stages} rules={rules} />}

        {view === 'etapas' && <>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ordered.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ol className="relative space-y-3">
              {ordered.map((s) => (
                <StageCard key={s.id} readOnly={!canEdit} stage={s} stages={stages} rules={rules.filter((r) => r.stage === s.id && triggerOf(r.trigger).stage)}
                  onEdit={() => setEditingStage(s)} onDelete={() => removeStage(s)} onAddRule={() => newRule({ stage: s.id })}
                  onEditRule={setEditingRule} onToggleRule={toggle} onDeleteRule={remove} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>

        <section className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <Zap className="size-4 text-accent" />
            <h2 className="font-semibold">Gatilhos do workspace</h2>
            {canEdit && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => newRule({ trigger: 'created', stage: '' })}><Plus className="size-3.5" /> Regra</Button>}
          </div>
          <p className="mb-3 text-xs text-mute">Regras que não dependem de etapa: issue criada (ex.: urgente avisa o time), comentário, fim da execução, prioridade, responsável, custo.</p>
          <div className="space-y-1.5">
            <RuleList readOnly={!canEdit} rules={globalRules} stages={stages} onEdit={setEditingRule} onToggle={toggle} onDelete={remove} />
            {!globalRules.length && <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-mute">Nenhuma ainda. Ex.: “Issue criada com prioridade Urgente → notificar só administradores”.</div>}
          </div>
        </section>

        {canEdit && <Intake stages={stages} />}
        </>}
      </div>
      {editingRule && <RuleModal rule={editingRule} stages={stages} onClose={() => setEditingRule(null)} onSaved={refresh} />}
      {editingStage && <StageModal stage={editingStage} stages={stages} onClose={() => setEditingStage(null)} onSaved={refresh} />}
      {copying && <CopyModal onClose={() => setCopying(false)} />}
    </div>
  );
}

// ---------- cartão de etapa ----------

function StageCard({ readOnly, stage: s, stages, rules, onEdit, onDelete, onAddRule, onEditRule, onToggleRule, onDeleteRule }: {
  readOnly?: boolean; stage: Stage; stages: Stage[]; rules: Rule[]; onEdit: () => void; onDelete: () => void; onAddRule: () => void;
  onEditRule: (r: Rule) => void; onToggleRule: (r: Rule) => void; onDeleteRule: (r: Rule) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id, disabled: readOnly });
  const p = s.policy ?? emptyPolicy();
  const badges: [typeof Lock, string][] = [];
  if (!isEmpty(p.act)) badges.push([ShieldCheck, 'acesso restrito']);
  if (!isEmpty(p.enter)) badges.push([ArrowRightLeft, 'entrada restrita']);
  if (p.locked?.length) badges.push([Lock, `${p.locked.length} campo(s) travado(s)`]);
  if (p.requires?.length) badges.push([Check, `${p.requires.length} requisito(s)`]);
  if (p.wip) badges.push([Inbox, `até ${p.wip} issues`]);
  if (p.readOnly) badges.push([Lock, 'somente leitura']);
  if (p.approvals) badges.push([UserCheck, `${p.approvals} aprovação(ões) → ${stages.find((x) => x.id === (p.approveTo || 'done'))?.name ?? '?'}`]);
  if (!isEmpty(p.responsible)) badges.push([Users, 'com responsáveis']);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={clsx('relative flex gap-2', isDragging && 'z-10 opacity-80')}>
      <button {...attributes} {...listeners} aria-label="Arrastar" className={clsx('mt-3 grid h-10 w-6 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-mute hover:bg-white/5 hover:text-fg active:cursor-grabbing', readOnly && 'invisible')}>
        <GripVertical className="size-4" />
      </button>
      <div className={clsx('surface min-w-0 flex-1 p-4', isDragging && 'shadow-pop')}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusIcon status={s.id} />
          <span className="font-semibold">{s.name}</span>
          <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={s.system ? undefined : { background: `${s.color}22`, color: s.color }}>
            {s.system ? <span className="text-mute">sistema</span> : 'personalizada'}
          </span>
          {s.parallel && <span className="rounded-md bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300" title="Fica ao lado da etapa anterior e divide a coluna dela no quadro">em paralelo com a anterior</span>}
          {!readOnly && <div className="ml-auto flex items-center gap-0.5">
            <button title="Configurar etapa" onClick={onEdit} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Settings2 className="size-4" /></button>
            {!s.system && <button title="Remover etapa" onClick={onDelete} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-4" /></button>}
            <Button size="sm" variant="ghost" onClick={onAddRule}><Plus className="size-3.5" /> Regra</Button>
          </div>}
        </div>
        <p className="mt-0.5 text-xs text-mute">{s.system ? BUILTIN[s.id] : 'Etapa sua: configure acesso e regras como quiser.'}</p>
        {badges.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {badges.map(([I, t]) => <span key={t} className="inline-flex items-center gap-1 rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-dim"><I className="size-3" /> {t}</span>)}
          </div>
        )}
        {rules.length > 0 && (
          <div className="mt-3">
            {rules.filter((r) => r.trigger === 'enter').length > 0 && <div className="mb-1.5 text-[11px] text-mute">Ao entrar, nesta ordem{readOnly ? '' : ' (arraste para mudar)'}:</div>}
            <RuleList readOnly={readOnly} rules={rules.filter((r) => r.trigger === 'enter')} stages={stages} sequence onEdit={onEditRule} onToggle={onToggleRule} onDelete={onDeleteRule} />
            {rules.some((r) => r.trigger !== 'enter') && <div className="mb-1.5 mt-3 text-[11px] text-mute">Ao sair ou quando ficar parada:</div>}
            <RuleList readOnly={readOnly} rules={rules.filter((r) => r.trigger !== 'enter')} stages={stages} onEdit={onEditRule} onToggle={onToggleRule} onDelete={onDeleteRule} />
          </div>
        )}
      </div>
    </li>
  );
}

// Lista ordenável de regras: a ordem é a ordem em que rodam.
function RuleList({ readOnly, rules, stages, onEdit, onToggle, onDelete, sequence }: {
  readOnly?: boolean; rules: Rule[]; stages: Stage[]; onEdit: (r: Rule) => void; onToggle: (r: Rule) => void; onDelete: (r: Rule) => void; sequence?: boolean;
}) {
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const [order, setOrder] = useState<string[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const list = order ? order.map((id) => rules.find((r) => r.id === id)!).filter(Boolean) : rules;
  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = list.map((r) => r.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrder(next);
    try {
      qc.setQueryData(['rules', ws.id], await api.put<Rule[]>(`/workspaces/${ws.id}/rules/order`, { ids: next }));
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setOrder(null);
    }
  };
  // "Mover" no meio corta a sequência: avisa quais regras nunca rodariam.
  const cut = sequence ? list.findIndex((r) => r.enabled && r.action === 'move') : -1;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={list.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1.5">
          {list.map((r, i) => (
            <div key={r.id}>
              <RuleRow readOnly={readOnly} rule={r} stages={stages} index={sequence ? i : undefined} onEdit={() => onEdit(r)} onToggle={() => onToggle(r)} onDelete={() => onDelete(r)} />
              {cut >= 0 && i === cut && cut < list.length - 1 && (
                <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-amber-400/[0.07] px-2.5 py-1.5 text-[11px] text-amber-200">
                  <AlertTriangle className="size-3 text-amber-400" /> Mover tira a issue da etapa: as regras abaixo não rodam. Arraste “Mover” para o fim.
                </div>
              )}
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// E-mail desligado no servidor: nenhuma regra de notificar envia nada.
function EmailOffAlert({ count }: { count?: number }) {
  const { ws } = useWs();
  const canSet = useCan('settings.manage');
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2.5 text-xs text-amber-200">
      <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
      <span className="min-w-0 flex-1">
        O envio de e-mail está <b>desligado</b>{count ? `: ${count} regra(s) de notificar não enviam nada` : ': esta regra não vai enviar nada'} até ele ser ligado.
        {!canSet && ' Peça a um administrador para ligar.'}
      </span>
      {canSet && <Link to={`/w/${ws.key}/config/servidor`} className="rounded-lg bg-amber-400/15 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-400/25">Ligar o envio de e-mail</Link>}
    </div>
  );
}

const isEmpty = (w?: Who) => !w || (!w.roles?.length && !w.users?.length);

function RuleRow({ readOnly, rule: r, stages, index, onEdit, onToggle, onDelete }: { readOnly?: boolean; rule: Rule; stages: Stage[]; index?: number; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: r.id, disabled: readOnly });
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: labels = [] } = useLabels(ws.id);
  const A = actionOf(r.action);
  const t = triggerOf(r.trigger);
  const c = r.config ?? {};
  const cond = r.conditions ?? {};
  const stageName = (id?: string) => stages.find((s) => s.id === id)?.name ?? 'etapa removida';
  const what = (() => {
    switch (r.action) {
      case 'notify': return `E-mail para ${(TARGETS.find(([k]) => k === (c.to ?? 'requester'))?.[1] ?? '').toLowerCase()}`;
      case 'webhook': return `POST ${c.url}`;
      case 'move': return `Mover para ${stageName(c.to)}`;
      case 'run_agent': return `${agents.find((x) => x.id === c.agentId)?.name ?? 'Agente da issue'}${c.request ? `: “${c.request}”` : ''}`;
      case 'set_agent': return `Agente: ${agents.find((x) => x.id === c.agentId)?.name ?? '?'}`;
      case 'set_priority': return `Prioridade: ${PRIORITIES.find((p) => p.id === c.priority)?.label ?? '?'}`;
      case 'add_label': return `Label: ${labels.find((l) => l.id === c.labelId)?.name ?? '?'}`;
      case 'assign': return { creator: 'Responsável: quem criou', requester: 'Responsável: quem pediu', balance: 'Distribuir entre o grupo (quem tem menos issues)' }[c.mode ?? ''] ?? 'Responsável fixo';
      case 'comment': return c.message;
      case 'open_pr': return `PR para ${c.base || 'a branch de destino'}${c.draft ? ' (rascunho)' : ''}`;
      case 'merge': return `Merge em ${c.base || 'a branch de destino'}`;
      case 'script': return (c.script ?? '').split('\n')[0];
    }
  })();
  const filters = [
    cond.priorities?.length ? cond.priorities.map((p) => PRIORITIES.find((x) => x.id === p)?.label).join('/') : '',
    cond.labels?.length ? `${cond.labels.length} label(s)` : '',
    cond.outcomes?.length ? cond.outcomes.map((o) => OUTCOMES.find(([k]) => k === o)?.[1]).join('/') : '',
    cond.hours ? `${cond.hours} h parada` : '', cond.cost ? `> US$ ${cond.cost}` : '',
    cond.actorRoles?.length ? 'por perfil' : '', cond.agents?.length ? 'por agente' : ''
  ].filter(Boolean);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('group relative flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-1.5 py-2', !r.enabled && 'opacity-50', isDragging && 'z-10 bg-panel shadow-pop')}>
      {!readOnly && (
        <button {...attributes} {...listeners} aria-label="Arrastar para mudar a ordem" className="grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-mute hover:text-fg active:cursor-grabbing">
          <GripVertical className="size-3.5" />
        </button>
      )}
      {index !== undefined && <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-dim">{index + 1}</span>}
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"><A.icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <Zap className="size-3 text-mute" /><span className="text-mute">{t.label.toLowerCase()}{!t.stage ? '' : ''}:</span>
          <span className="font-medium">{r.name || A.label}</span>
          {filters.map((f) => <span key={f} className="rounded bg-white/5 px-1 text-[10px] text-dim">{f}</span>)}
        </div>
        <div className="truncate text-xs text-dim">{what}</div>
      </div>
      {readOnly ? <span className="pr-1.5 text-[11px] text-mute">{r.enabled ? 'ativa' : 'desligada'}</span> : <>
        <Toggle checked={r.enabled} onChange={onToggle} />
        <button onClick={onEdit} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-3.5" /></button>
        <button onClick={onDelete} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-3.5" /></button>
      </>}
    </div>
  );
}

// ---------- quem: perfis + pessoas com acesso ----------

function WhoPicker({ value, onChange, empty }: { value: Who; onChange: (w: Who) => void; empty: string }) {
  const { ws } = useWs();
  const { data: roles = [] } = useRoles();
  const { data: members = [] } = useMembers(ws.id);
  const r = value.roles ?? [];
  const u = value.users ?? [];
  const toggle = (k: 'roles' | 'users', id: string) => {
    const list = k === 'roles' ? r : u;
    onChange({ ...value, [k]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  };
  const chips = [...roles.filter((x) => r.includes(x.id)).map((x) => ({ k: 'roles' as const, id: x.id, label: x.name, role: true })),
    ...members.filter((m) => u.includes(m.id)).map((m) => ({ k: 'users' as const, id: m.id, label: m.name, role: false }))];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!chips.length && <span className="rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-mute">{empty}</span>}
      {chips.map((c) => (
        <button key={c.k + c.id} type="button" onClick={() => toggle(c.k, c.id)} title="Remover"
          className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs hover:border-red-400/50 hover:bg-red-400/10">
          {c.role ? <ShieldCheck className="size-3 text-accent" /> : <span className="grid size-3.5 place-items-center rounded-full bg-white/15 text-[8px] font-bold">{c.label[0]}</span>}
          {c.label}
        </button>
      ))}
      <Popover className="w-64 p-1.5" trigger={() => <button type="button" className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-dim hover:bg-hover"><Plus className="size-3" /> Adicionar</button>}>
        {() => (
          <div className="max-h-72 overflow-y-auto">
            <div className="px-2 pb-1 pt-1 text-[11px] text-mute">Perfis</div>
            {roles.map((x) => (
              <button key={x.id} type="button" onClick={() => toggle('roles', x.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]">
                <ShieldCheck className="size-3.5 text-mute" /> <span className="flex-1">{x.name}</span> {r.includes(x.id) && <Check className="size-3.5 text-accent" />}
              </button>
            ))}
            <div className="px-2 pb-1 pt-2 text-[11px] text-mute">Pessoas com acesso a este workspace</div>
            {members.map((m) => (
              <button key={m.id} type="button" onClick={() => toggle('users', m.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]">
                <span className="grid size-4 place-items-center rounded-full bg-white/10 text-[9px] font-bold">{m.name[0]}</span>
                <span className="min-w-0 flex-1 truncate">{m.name} <span className="text-mute">· {m.isOwner ? 'dono' : m.roleName}</span></span>
                {u.includes(m.id) && <Check className="size-3.5 text-accent" />}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

function Chips<T extends string | number>({ options, value, onChange }: { options: [T, string][]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([k, label]) => {
        const on = value.includes(k);
        return (
          <button key={String(k)} type="button" onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}
            className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition', on ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-dim hover:bg-hover hover:text-fg')}>
            {on && <Check className="size-3 text-accent" />}{label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- configurar etapa ----------

function StageModal({ stage, stages, onClose, onSaved }: { stage: Partial<Stage> & { after?: string }; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs();
  const [s, setS] = useState({ ...stage, policy: { ...emptyPolicy(), ...(stage.policy ?? {}) } });
  const [tab, setTab] = useState<'geral' | 'acesso' | 'regras' | 'aprovacao'>('geral');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const p = s.policy;
  const setP = (patch: Partial<StagePolicy>) => setS({ ...s, policy: { ...p, ...patch } });
  const COLORS = ['#a78bfa', '#60a5fa', '#22d3ee', '#34d399', '#a3e635', '#fbbf24', '#fb923c', '#f87171', '#f472b6', '#94a3b8'];
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: s.name, color: s.color, after: s.after ?? '', policy: p, parallel: !!s.parallel };
      if (s.id) await api.put(`/workspaces/${ws.id}/stages/${s.id}`, body);
      else await api.post(`/workspaces/${ws.id}/stages`, body);
      onSaved();
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const TABS: [typeof tab, string][] = [['geral', 'Geral'], ['acesso', 'Quem pode'], ['regras', 'Travas e requisitos'], ['aprovacao', 'Aprovação']];
  return (
    <Modal open wide onClose={onClose} title={s.id ? `Etapa ${stage.name}` : 'Nova etapa'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="-mt-1 mb-5 flex gap-1 border-b border-line">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={clsx('-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors', tab === id ? 'border-accent font-medium text-fg' : 'border-transparent text-mute hover:text-fg')}>{label}</button>
        ))}
      </div>
      {tab === 'geral' && (
        <div className="space-y-4">
          <Field label="Nome"><input autoFocus className="field-input" value={s.name ?? ''} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Ex.: Triagem, Desenvolvimento, QA, Homologação" /></Field>
          {!s.id && (
            <Field label="Entra depois de">
              <select className="field-input" value={s.after ?? ''} onChange={(e) => setS({ ...s, after: e.target.value })}>
                {stages.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
          )}
          {!s.system && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-dim">Cor</span>
              <div className="flex flex-wrap gap-2">
                {COLORS.map((c) => <button key={c} type="button" onClick={() => setS({ ...s, color: c })} style={{ background: c }} className={clsx('size-6 rounded-full transition hover:scale-110', s.color === c && 'ring-2 ring-white/80 ring-offset-2 ring-offset-panel')} />)}
              </div>
            </div>
          )}
          {s.system && <p className="text-xs text-mute">{BUILTIN[s.id!]} O nome pode mudar; o comportamento continua.</p>}
          <label className={clsx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', s.parallel ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-white/15')}>
            <Toggle checked={!!s.parallel} onChange={(parallel) => setS({ ...s, parallel })} />
            <span>
              <span className="block text-[13px] font-medium">Em paralelo com a etapa anterior</span>
              <span className="block text-xs text-mute">Fica ao lado dela no fluxo e divide a mesma coluna no quadro, uma embaixo da outra. Ex.: depois de “Prioridade”, “Difícil” e “Médio” em paralelo, e uma regra manda cada tipo de issue para a sua.</span>
            </span>
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">Responsáveis da etapa <span className="font-normal text-mute">· recebem o e-mail “responsáveis da etapa”</span></span>
            <WhoPicker value={p.responsible} onChange={(responsible) => setP({ responsible })} empty="ninguém" />
          </div>
        </div>
      )}
      {tab === 'acesso' && (
        <div className="space-y-5">
          <p className="text-xs text-mute">Vale junto com as permissões do perfil. Ex.: estagiário e júnior podem ter o mesmo perfil de permissões, mas aqui você diz que só o estagiário mexe na Triagem e só o júnior no Desenvolvimento. O dono sempre pode tudo.</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">Quem mexe nas issues desta etapa <span className="font-normal text-mute">· editar, comentar, rodar agente, tirar daqui</span></span>
            <WhoPicker value={p.act} onChange={(act) => setP({ act })} empty="todos com permissão" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">Quem pode trazer issues para cá</span>
            <WhoPicker value={p.enter} onChange={(enter) => setP({ enter })} empty="todos com permissão" />
          </div>
        </div>
      )}
      {tab === 'regras' && (
        <div className="space-y-5">
          <label className={clsx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', p.readOnly ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-white/15')}>
            <Toggle checked={!!p.readOnly} onChange={(readOnly) => setP({ readOnly })} />
            <span>
              <span className="block text-[13px] font-medium">Somente leitura</span>
              <span className="block text-xs text-mute">Entrou aqui, ninguém mexe mais: sem editar, comentar, rodar agente, aprovar ou tirar daqui. Bom para Concluída ou Arquivada. Só o dono consegue, como saída de emergência; as regras da etapa continuam rodando.</span>
            </span>
          </label>
          <div className={clsx('flex flex-col gap-1.5', p.readOnly && 'pointer-events-none opacity-40')}>
            <span className="text-xs font-medium text-dim">Travar nesta etapa <span className="font-normal text-mute">· ninguém altera enquanto a issue estiver aqui</span></span>
            <Chips options={LOCKS} value={p.locked ?? []} onChange={(locked) => setP({ locked })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">Para entrar aqui a issue precisa</span>
            <Chips options={REQUIRES} value={p.requires ?? []} onChange={(requires) => setP({ requires })} />
          </div>
          <Field label="Limite de issues ao mesmo tempo" hint="0 = sem limite">
            <input type="number" min={0} className="field-input w-32" value={p.wip ?? 0} onChange={(e) => setP({ wip: Math.max(0, Number(e.target.value)) })} />
          </Field>
        </div>
      )}
      {tab === 'aprovacao' && (
        <div className="space-y-5">
          <Field label="Aprovações necessárias" hint="0 = etapa sem aprovação">
            <input type="number" min={0} max={10} className="field-input w-32" value={p.approvals ?? 0} onChange={(e) => setP({ approvals: Math.min(10, Math.max(0, Number(e.target.value))) })} />
          </Field>
          {!!p.approvals && <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-dim">Quem aprova</span>
              <WhoPicker value={p.approvers} onChange={(approvers) => setP({ approvers })} empty="quem tem a permissão de aprovar" />
            </div>
            <Field label="Aprovada, vai para">
              <select className="field-input" value={p.approveTo || 'done'} onChange={(e) => setP({ approveTo: e.target.value })}>
                {stages.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <p className="text-xs text-mute">Cada pessoa aprova uma vez. Com {p.approvals} aprovação(ões) diferentes a issue segue sozinha, e as regras da etapa de destino disparam.</p>
          </>}
        </div>
      )}
    </Modal>
  );
}

// ---------- regra ----------

// Assistente de regra em passos curtos: Quando → O que fazer → Detalhes →
// Filtros (opcional). Escolher a ação já avança; "+ Regra" numa etapa abre
// direto em "O que fazer", com o gatilho da etapa já preenchido.
type WizardStep = 0 | 1 | 2 | 3;
const STEPS = ['Quando', 'O que fazer', 'Detalhes', 'Filtros'];

function RuleModal({ rule, stages, onClose, onSaved }: { rule: Partial<Rule>; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: labels = [] } = useLabels(ws.id);
  const { data: roles = [] } = useRoles();
  const { data: email } = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<{ enabled: boolean }>('/settings/email') });
  const [r, setR] = useState<Partial<Rule>>({ ...rule, config: { ...(rule.config ?? {}) }, conditions: { ...(rule.conditions ?? {}) } });
  const [step, setStep] = useState<WizardStep>(rule.id ? 2 : rule.stage ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const c = r.config ?? {};
  const cond = r.conditions ?? {};
  const setC = (p: Partial<RuleConfig>) => setR({ ...r, config: { ...c, ...p } });
  const setCond = (p: Partial<RuleConditions>) => setR({ ...r, conditions: { ...cond, ...p } });
  const t = triggerOf(r.trigger ?? 'enter');
  const stageName = stages.find((s) => s.id === r.stage)?.name;
  const others = stages.filter((s) => s.id !== r.stage);
  const A = actionOf(r.action ?? 'notify');
  const nFilters = Object.values(cond).filter((v) => (Array.isArray(v) ? v.length : false)).length;

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: r.name ?? '', trigger: r.trigger, stage: t.stage ? r.stage : '', action: r.action, config: c, conditions: cond, enabled: r.enabled ?? true };
      if (r.id) await api.put(`/rules/${r.id}`, body);
      else await api.post(`/workspaces/${ws.id}/rules`, body);
      onSaved();
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summary = [t.label + (t.stage && stageName ? ` · ${stageName}` : ''), A.label, r.name || '', nFilters ? `${nFilters} filtro(s)` : 'sem filtros'];
  const onFail = (
    <Field label="Se falhar, mover para" hint="opcional">
      <select className="field-input" value={c.onFail ?? ''} onChange={(e) => setC({ onFail: e.target.value })}>
        <option value="">{r.action === 'run_agent' ? 'Bloqueada (padrão)' : 'não mover (só registrar)'}</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Field>
  );

  const footer = (
    <>
      {step > 0 && <Button variant="ghost" onClick={() => setStep((step - 1) as WizardStep)}>Voltar</Button>}
      <span className="flex-1" />
      {step === 0 && <Button variant="primary" onClick={() => setStep(1)}>Continuar</Button>}
      {step === 2 && <Button onClick={() => setStep(3)}>Filtros{nFilters ? ` (${nFilters})` : ''}</Button>}
      {step >= 2 && <Button variant="primary" loading={busy} onClick={save}>Salvar</Button>}
    </>
  );

  return (
    <Modal open onClose={onClose} title={r.id ? 'Editar regra' : 'Nova regra'} footer={footer}>
      {/* Passos: clicáveis para pular direto; cada um mostra o que já foi escolhido. */}
      <div className="-mt-1 mb-4 flex items-center gap-1">
        {STEPS.map((label, i) => (
          <button key={label} type="button" onClick={() => setStep(i as WizardStep)} title={summary[i]}
            className={clsx('flex min-w-0 flex-1 flex-col items-start rounded-lg px-2 py-1.5 text-left transition', step === i ? 'bg-accent/15' : 'hover:bg-white/[0.04]')}>
            <span className={clsx('flex items-center gap-1 text-[11px] font-medium', step === i ? 'text-accent' : i < step ? 'text-dim' : 'text-mute')}>
              {i < step ? <Check className="size-3" /> : <span>{i + 1}</span>} {label}
            </span>
            <span className="w-full truncate text-[10px] text-mute">{summary[i]}</span>
          </button>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <div className="grid gap-1">
            {TRIGGERS.map((x) => (
              <button key={x.id} type="button" onClick={() => setR({ ...r, trigger: x.id, stage: x.stage ? (r.stage || stages[0]?.id) : '' })}
                className={clsx('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition', r.trigger === x.id ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-white/[0.04]')}>
                <span className={clsx('grid size-4 place-items-center rounded-full border', r.trigger === x.id ? 'border-accent' : 'border-line')}>{r.trigger === x.id && <span className="size-2 rounded-full bg-accent" />}</span>
                <span className="min-w-0"><span className="block text-[13px]">{x.label}</span><span className="block text-[11px] text-mute">{x.hint}</span></span>
              </button>
            ))}
          </div>
          {(t.stage || r.trigger === 'cost_over' || r.trigger === 'run_finished') && (
            <div className="grid gap-3 rounded-xl border border-white/[0.06] bg-black/10 p-3 sm:grid-cols-2">
              {t.stage && (
                <Field label="Etapa">
                  <select className="field-input" value={r.stage} onChange={(e) => setR({ ...r, stage: e.target.value })}>
                    {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
              {r.trigger === 'stale' && <Field label="Parada há mais de (horas)"><input type="number" min={1} className="field-input" value={cond.hours ?? 24} onChange={(e) => setCond({ hours: Number(e.target.value) })} /></Field>}
              {r.trigger === 'cost_over' && <Field label="Custo acima de (US$)"><input type="number" min={0.1} step={0.5} className="field-input" value={cond.cost ?? 5} onChange={(e) => setCond({ cost: Number(e.target.value) })} /></Field>}
              {r.trigger === 'run_finished' && (
                <div className="flex flex-col gap-1.5 sm:col-span-2"><span className="text-xs font-medium text-dim">Só quando o resultado for</span>
                  <Chips options={OUTCOMES} value={cond.outcomes ?? []} onChange={(outcomes) => setCond({ outcomes })} /></div>
              )}
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="grid grid-cols-2 gap-1.5">
          {ACTIONS.map((a) => (
            <button key={a.id} type="button" title={a.desc}
              onClick={() => { setR({ ...r, action: a.id, config: a.id === r.action ? c : a.id === 'notify' ? { to: 'requester' } : {} }); setStep(2); }}
              className={clsx('flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition', r.action === a.id ? 'border-accent/60 bg-accent/10' : 'border-line bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.05]')}>
              <span className={clsx('grid size-7 shrink-0 place-items-center rounded-lg', r.action === a.id ? 'bg-accent/20 text-accent' : 'bg-white/5 text-dim')}><a.icon className="size-3.5" /></span>
              <span className="min-w-0 truncate text-[13px] font-medium">{a.label}</span>
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-mute"><A.icon className="size-3.5 text-accent" /> {A.desc}</div>
          {r.action === 'notify' && <>
            {email && !email.enabled && <EmailOffAlert />}
            <Field label="Para quem">
              <select className="field-input" value={c.to ?? 'requester'} onChange={(e) => setC({ to: e.target.value, roles: [], users: [] })}>
                {TARGETS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            {(c.to === 'roles' || c.to === 'users') && (
              <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC(c.to === 'roles' ? { roles: w.roles } : { users: w.users })} empty={c.to === 'roles' ? 'escolha perfis' : 'escolha pessoas'} />
            )}
            <Field label="Mensagem" hint="opcional"><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder="Ex.: revisar até o fim do dia" /></Field>
          </>}
          {r.action === 'webhook' && <>
            <Field label="URL"><input className="field-input font-mono text-xs" value={c.url ?? ''} onChange={(e) => setC({ url: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></Field>
            <Field label="Mensagem" hint="opcional"><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} /></Field>
          </>}
          {r.action === 'comment' && <Field label="Comentário"><textarea className="field-input" rows={3} value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder="Ex.: antes de aprovar, confira o checklist de segurança." /></Field>}
          {r.action === 'move' && <>
            <Field label="Mover para">
              <select className="field-input" value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value })}>
                <option value="" disabled>escolha a etapa</option>
                {(t.stage ? others : stages).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            {t.stage && <p className="text-xs text-mute">Mover encerra a sequência da etapa: deixe esta regra por último.</p>}
          </>}
          {r.action === 'assign' && <>
            <Field label="Quem vira responsável">
              <select className="field-input" value={c.mode ?? 'user'} onChange={(e) => setC({ mode: e.target.value, users: [], roles: [] })}>
                <option value="user">Uma pessoa fixa</option>
                <option value="creator">Quem criou a issue</option>
                <option value="requester">Quem pediu</option>
                <option value="balance">Distribuir: quem tiver menos issues no grupo</option>
              </select>
            </Field>
            {(c.mode ?? 'user') === 'user' && <WhoPicker value={{ users: c.users }} onChange={(w) => setC({ users: (w.users ?? []).slice(-1) })} empty="escolha a pessoa" />}
            {c.mode === 'balance' && <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty="escolha perfis e/ou pessoas" />}
          </>}
          {r.action === 'set_priority' && (
            <Field label="Prioridade">
              <select className="field-input" value={c.priority ?? 1} onChange={(e) => setC({ priority: Number(e.target.value) })}>
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
          )}
          {r.action === 'add_label' && (
            <Field label="Label">
              <select className="field-input" value={c.labelId ?? ''} onChange={(e) => setC({ labelId: e.target.value })}>
                <option value="" disabled>escolha</option>
                {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          {(r.action === 'run_agent' || r.action === 'set_agent') && (
            <div className="flex flex-wrap gap-1.5">
              {r.action === 'run_agent' && <button type="button" onClick={() => setC({ agentId: '' })} className={clsx('rounded-full border px-3 py-1 text-xs', !c.agentId ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>O da issue</button>}
              {agents.map((a) => (
                <button key={a.id} type="button" onClick={() => setC({ agentId: a.id })} className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', c.agentId === a.id ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>
                  <AgentIcon avatar={a.avatar} size={14} /> {a.name}
                </button>
              ))}
            </div>
          )}
          {r.action === 'run_agent' && <>
            <Field label="O que pedir" hint="vazio = executar a issue"><textarea className="field-input" rows={3} value={c.request ?? ''} onChange={(e) => setC({ request: e.target.value })} placeholder="Ex.: revise o diff e rode os testes." /></Field>
            <p className="text-xs text-mute">{t.stage
              ? 'A issue fica nesta etapa enquanto o agente trabalha; as regras seguintes rodam quando ele terminar. Se ele precisar de alguém, a issue vai para Aguardando você.'
              : 'Pedido normal: a issue vai para Em andamento e segue o resultado do agente.'}</p>
            {t.stage && onFail}
          </>}
          {r.action === 'open_pr' && <>
            <Field label="Branch de destino do PR" hint="vazio = a de merge da issue"><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder="main" /></Field>
            <Toggle checked={!!c.draft} onChange={(draft) => setC({ draft })} label="Abrir como rascunho" />
            {onFail}
          </>}
          {r.action === 'merge' && <Field label="Branch" hint="vazio = a de merge de cada repositório"><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder="main" /></Field>}
          {r.action === 'script' && <>
            <Field label="Script (bash)">
              <textarea className="field-input font-mono text-xs" rows={4} spellCheck={false} value={c.script ?? ''} onChange={(e) => setC({ script: e.target.value })}
                placeholder={'curl -X POST https://ci.exemplo.com/deploy -d "branch=$MULTICA_BRANCH"'} />
            </Field>
            <p className="text-[11px] text-mute">MULTICA_ISSUE, _TITLE, _BRANCH, _STAGE, _FROM, _EVENT, _PRIORITY, _README, _WORKSPACE · até 10 min.</p>
            {onFail}
          </>}
          <div className="flex items-end gap-3 border-t border-line/60 pt-3">
            <Field label="Nome" hint="opcional" className="flex-1"><input className="field-input" value={r.name ?? ''} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder={A.label} /></Field>
            <div className="pb-2"><Toggle checked={r.enabled ?? true} onChange={(enabled) => setR({ ...r, enabled })} label="Ativa" /></div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <p className="text-xs text-mute">A regra só dispara se a issue atender a todos os filtros marcados. Sem filtros, vale para toda issue.</p>
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">Prioridade é</span>
            <Chips options={PRIORITIES.map((p) => [p.id, p.label] as [number, string])} value={cond.priorities ?? []} onChange={(priorities) => setCond({ priorities })} /></div>
          {labels.length > 0 && <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">Tem alguma destas labels</span>
            <Chips options={labels.map((l) => [l.id, l.name] as [string, string])} value={cond.labels ?? []} onChange={(l) => setCond({ labels: l })} /></div>}
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">Agente da issue é</span>
            <Chips options={agents.map((a) => [a.id, a.name] as [string, string])} value={cond.agents ?? []} onChange={(a) => setCond({ agents: a })} /></div>
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">Quem causou tem o perfil</span>
            <Chips options={roles.map((x) => [x.id, x.name] as [string, string])} value={cond.actorRoles ?? []} onChange={(actorRoles) => setCond({ actorRoles })} /></div>
        </div>
      )}
    </Modal>
  );
}

// ---------- copiar para outro workspace ----------

function CopyModal({ onClose }: { onClose: () => void }) {
  const { ws } = useWs();
  const { data: workspaces = [] } = useWorkspaces();
  const qc = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<{ warnings: WorkflowWarning[]; stages: number; rules: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = workspaces.filter((w) => w.id !== ws.id);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await api.post<{ warnings: WorkflowWarning[]; stages: number; rules: number }>(`/workspaces/${ws.id}/workflow/copy`, { to, dryRun });
      if (dryRun) setPreview(res);
      else {
        toast('success', `Fluxo copiado: ${res.stages} etapas e ${res.rules} regras`);
        qc.invalidateQueries({ queryKey: ['stages', to] });
        qc.invalidateQueries({ queryKey: ['rules', to] });
        onClose();
      }
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Copiar fluxo para outro workspace"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        {preview ? <Button variant="primary" loading={busy} onClick={() => run(false)}>Substituir o fluxo do destino</Button>
          : <Button variant="primary" loading={busy} disabled={!to} onClick={() => run(true)}>Ver o que muda</Button>}</>}>
      <div className="space-y-4">
        <Field label="Destino">
          <select className="field-input" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }}>
            <option value="" disabled>escolha o workspace</option>
            {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <p className="text-xs text-mute">Copia etapas, acessos, travas, aprovações e regras de <b className="text-dim">{ws.name}</b>. Perfis e agentes são globais e vão iguais; pessoas sem acesso ao destino saem das listas, e labels são recriadas pelo nome. Issues do destino em etapas que deixarem de existir vão para o Backlog.</p>
        {preview && (
          <div className={clsx('rounded-xl border p-3 text-xs', preview.warnings.length ? 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200' : 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200')}>
            <div className="mb-1 font-medium">{preview.stages} etapas e {preview.rules} regras · {preview.warnings.length ? `${preview.warnings.length} ajuste(s) automático(s):` : 'nada a ajustar.'}</div>
            <ul className="space-y-0.5 pl-4">{preview.warnings.map((w, i) => <li key={i} className="list-disc"><b className="font-medium">{w.where}:</b> {w.message}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- entrada de issues por webhook ----------

function Intake({ stages }: { stages: Stage[] }) {
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['intake', ws.id], queryFn: () => api.get<{ enabled: boolean; stage: string; path?: string }>(`/workspaces/${ws.id}/intake`) });
  const [open, setOpen] = useState(false);
  const save = async (body: { enabled: boolean; stage: string; rotate?: boolean }) => {
    try {
      qc.setQueryData(['intake', ws.id], await api.put(`/workspaces/${ws.id}/intake`, body));
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  if (!data) return null;
  const url = data.path ? `${location.origin}${data.path}` : '';
  return (
    <section className="mt-8 surface p-4">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
        <Inbox className="size-4 text-accent" />
        <span className="font-semibold">Entrada de issues</span>
        <span className="text-xs text-mute">webhook · e-mail encaminhado · formulários</span>
        <span className={clsx('ml-auto rounded-full px-2 py-0.5 text-[11px]', data.enabled ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/5 text-mute')}>{data.enabled ? 'ligada' : 'desligada'}</span>
        <ChevronDown className={clsx('size-4 text-mute transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-4 space-y-3 text-[13px]">
          <p className="text-xs text-mute">Um endereço que cria issues sozinho. Use para “quando cair um e-mail na caixa”: encaminhe com Cloudflare Email Routing, n8n, Zapier ou Make para este endereço. Aceita <code>{'{title, description, priority}'}</code> ou <code>{'{subject, text, from}'}</code>. A issue dispara as regras de “Issue criada”.</p>
          <div className="flex flex-wrap items-end gap-3">
            <Toggle checked={data.enabled} onChange={(enabled) => save({ enabled, stage: data.stage })} label="Ligada" />
            <Field label="Cria em" className="w-56">
              <select className="field-input" value={data.stage} onChange={(e) => save({ enabled: data.enabled, stage: e.target.value })}>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          {url && (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-[11px]">{url}</code>
              <Button size="sm" onClick={() => { navigator.clipboard?.writeText(url); toast('success', 'Endereço copiado'); }}><Copy className="size-3.5" /></Button>
              <Button size="sm" variant="ghost" title="Gerar outro endereço (o antigo para de funcionar)" onClick={() => confirm('Gerar um endereço novo? O atual para de funcionar.') && save({ enabled: true, stage: data.stage, rotate: true })}><RefreshCw className="size-3.5" /></Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
