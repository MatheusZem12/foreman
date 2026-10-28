import { useMemo, useState } from 'react';
import { FlowMap } from './FlowMap';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle, ArrowRightLeft, ListChecks, ListOrdered, LogIn, LogOut, Map as MapIcon, Bot, Check, ChevronDown, Copy, Flag, GitMerge, GitPullRequest,
  GripVertical, Inbox, Lock, Mail, MessageSquare, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, SquareTerminal, Tag, Timer, Trash2,
  UserCheck, Users, Webhook, Workflow, Zap
} from 'lucide-react';
import { useWs } from '../components/Layout';
import { Button, Field, Modal, PageHeader, Popover, StatusIcon, Toggle, useToast } from '../components/ui';
import { AgentIcon } from '../components/AgentIcon';
import { api } from '../lib/api';
import { PRIORITIES, localizeStages, stageGroups } from '../lib/constants';
import { useAgents, useCan, useLabels, useMembers, useRoles, useRules, useStages, useWorkspaces } from '../lib/queries';
import type { LockField, Requirement, Rule, RuleAction, RuleConditions, RuleConfig, RuleTrigger, Stage, Who, WorkflowWarning } from '../lib/types';
import { t } from '../lib/i18n';

// ---------- catálogos ----------

const BUILTIN: Record<string, string> = {
  backlog: t('Ideias e tarefas que ainda não rodam.'),
  todo: t('Com agente, a issue entra na fila na hora.'),
  in_progress: t('O agente está trabalhando. Todo pedido novo vem para cá.'),
  waiting: t('A IA parou e precisa de alguém: decisão, acesso, dado ou confirmação.'),
  in_review: t('A IA terminou. Quem aprova dá o ✓.'),
  blocked: t('A execução falhou ou o merge deu conflito.'),
  done: t('Aprovada e entregue.'),
  cancelled: t('Interrompida; a execução em andamento para.')
};

const TRIGGERS: { id: RuleTrigger; label: string; stage?: boolean; hint: string }[] = [
  { id: 'access', label: t('Sempre: acesso e travas'), stage: true, hint: t('quem mexe ou traz issues, aprovação, travas, requisitos, limite, responsáveis') },
  { id: 'enter', label: t('Entrar na etapa'), stage: true, hint: t('venha do quadro, do agente ou de outra regra') },
  { id: 'leave', label: t('Sair da etapa'), stage: true, hint: t('para qualquer outra') },
  { id: 'stale', label: t('Ficar parada na etapa'), stage: true, hint: t('por X horas sem sair dela') },
  { id: 'created', label: t('Issue criada'), hint: t('no quadro, por webhook ou e-mail encaminhado') },
  { id: 'commented', label: t('Novo comentário'), hint: t('de uma pessoa') },
  { id: 'run_finished', label: t('Execução do agente terminou'), hint: t('concluída, aguardando, incompleta ou com falha') },
  { id: 'assigned', label: t('Responsável definido'), hint: t('alguém virou dono da issue') },
  { id: 'priority_changed', label: t('Prioridade trocada'), hint: t('use a condição para pegar só urgentes') },
  { id: 'cost_over', label: t('Custo passou de um valor'), hint: t('soma das execuções em US$') }
];
const triggerOf = (tt: RuleTrigger) => TRIGGERS.find((x) => x.id === tt) ?? TRIGGERS[0];

const ACTIONS: { id: RuleAction; icon: typeof Mail; label: string; desc: string; group: string }[] = [
  { id: 'notify', icon: Mail, label: t('Notificar por e-mail'), desc: t('Responsável, time, admins, perfis ou pessoas.'), group: t('Avisar') },
  { id: 'webhook', icon: Webhook, label: t('Webhook'), desc: t('Slack, Discord, Teams, n8n…'), group: t('Avisar') },
  { id: 'comment', icon: MessageSquare, label: t('Comentar'), desc: t('Deixa uma instrução fixa na issue.'), group: t('Avisar') },
  { id: 'move', icon: ArrowRightLeft, label: t('Mover para etapa'), desc: t('Encaminha a issue.'), group: t('Organizar') },
  { id: 'assign', icon: UserCheck, label: t('Definir responsável'), desc: t('Fixo, quem criou ou distribuir entre um grupo.'), group: t('Organizar') },
  { id: 'set_priority', icon: Flag, label: t('Definir prioridade'), desc: t('Ex.: issue de cliente vira urgente.'), group: t('Organizar') },
  { id: 'add_label', icon: Tag, label: t('Adicionar label'), desc: t('Marca a issue.'), group: t('Organizar') },
  { id: 'set_agent', icon: Bot, label: t('Definir agente'), desc: t('Escolhe o agente da issue.'), group: t('IA e código') },
  { id: 'run_agent', icon: Sparkles, label: t('Rodar agente'), desc: t('Revisão por IA, testes, documentação…'), group: t('IA e código') },
  { id: 'open_pr', icon: GitPullRequest, label: t('Abrir pull request'), desc: t('GitHub, via gh.'), group: t('IA e código') },
  { id: 'merge', icon: GitMerge, label: t('Fazer merge'), desc: t('Tudo ou nada entre repositórios.'), group: t('IA e código') },
  { id: 'script', icon: SquareTerminal, label: t('Rodar script'), desc: t('Bash com variáveis MULTICA_*.'), group: t('IA e código') }
];
// Regras de acesso: não "rodam"; valem o tempo todo enquanto a issue está na etapa.
const ACCESS: { id: RuleAction; icon: typeof Mail; label: string; desc: string }[] = [
  { id: 'allow_act', icon: ShieldCheck, label: t('Quem mexe nas issues'), desc: t('Só essas pessoas editam, comentam, rodam o agente e tiram a issue daqui.') },
  { id: 'allow_enter', icon: LogIn, label: t('Quem traz issues para cá'), desc: t('Só essas pessoas movem (ou criam) issues nesta etapa.') },
  { id: 'approval', icon: UserCheck, label: t('Exigir aprovação'), desc: t('A issue só segue quando pessoas diferentes derem o ✓.') },
  { id: 'lock_fields', icon: Lock, label: t('Travar campos'), desc: t('Ninguém altera esses campos enquanto a issue estiver aqui.') },
  { id: 'require', icon: ListChecks, label: t('Requisitos para entrar'), desc: t('A issue só entra se tiver o que for marcado.') },
  { id: 'wip', icon: Inbox, label: t('Limite de issues'), desc: t('Máximo de issues ao mesmo tempo nesta etapa.') },
  { id: 'read_only', icon: Lock, label: t('Somente leitura'), desc: t('Entrou aqui, ninguém mexe mais. Só o dono, como saída de emergência.') },
  { id: 'responsible', icon: Users, label: t('Responsáveis da etapa'), desc: t('Recebem o e-mail “responsáveis da etapa”.') }
];
const isAccess = (tt?: RuleTrigger) => tt === 'access';
const actionOf = (id: RuleAction) => ACTIONS.find((a) => a.id === id) ?? ACCESS.find((a) => a.id === id) ?? ACTIONS[0];

const TARGETS: [string, string][] = [
  ['requester', t('Quem pediu (último pedido ao agente)')],
  ['creator', t('Quem criou a issue')],
  ['assignee', t('O responsável pela issue')],
  ['responsible', t('Os responsáveis da etapa')],
  ['team', t('O time (todo o workspace)')],
  ['admins', t('Só administradores')],
  ['roles', t('Perfis escolhidos')],
  ['users', t('Usuários escolhidos')]
];

const LOCKS: [LockField, string][] = [
  ['title', t('Título')], ['description', t('Descrição e README')], ['priority', t('Prioridade')], ['labels', t('Labels')],
  ['agent', t('Agente')], ['repos', t('Repositórios')], ['assignee', t('Responsável')]
];
const REQUIRES: [Requirement, string][] = [
  ['agent', t('Ter agente')], ['assignee', t('Ter responsável')], ['description', t('Ter descrição')], ['changes', t('Ter alterações de código')]
];
const OUTCOMES: [string, string][] = [['done', t('Concluída')], ['waiting', t('Aguardando alguém')], ['incomplete', t('Incompleta')], ['failed', t('Falhou')]];

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
      qc.setQueryData(['stages', ws.id], localizeStages(await api.put<Stage[]>(`/workspaces/${ws.id}/stages/order`, { ids: next })));
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
    if (!confirm(t('Remover esta regra?'))) return;
    await api.del(`/rules/${r.id}`);
    refresh();
  };
  const removeStage = async (s: Stage) => {
    if (!confirm(t('Remover a etapa "{0}"? As issues dela voltam para o Backlog e as regras dela são apagadas.', s.name))) return;
    await api.del(`/workspaces/${ws.id}/stages/${s.id}`);
    refresh();
    qc.invalidateQueries({ queryKey: ['issues', ws.id] });
  };
  const newRule = (p: Partial<Rule>) => setEditingRule({ trigger: 'enter', action: 'notify', config: { to: 'requester' }, conditions: {}, enabled: true, ...p });
  const globalRules = rules.filter((r) => !triggerOf(r.trigger).stage);

  return (
    <div className="h-full overflow-y-auto">
      <div className={clsx('mx-auto p-4 pb-24 md:p-8', view === 'mapa' ? 'max-w-6xl' : 'max-w-4xl')}>
        <PageHeader
          icon={Workflow}
          title={t('Fluxo e automações')}
          description={t('As etapas do quadro, quem pode fazer o quê em cada uma e as regras que rodam sozinhas. As regras de uma etapa rodam de cima para baixo{0}.', canEdit ? t('; arraste etapas e regras para mudar a ordem') : '')}
          actions={canEdit ? <>
            <Button onClick={() => setCopying(true)}><Copy className="size-4" /> {t('Copiar para…')}</Button>
            <Button variant="primary" onClick={() => setEditingStage({ after: 'in_review' })}><Plus className="size-4" /> {t('Nova etapa')}</Button>
          </> : <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-mute">{t('somente leitura')}</span>}
        />

        {warnings.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-200">
            <div className="mb-1.5 flex items-center gap-2 font-medium"><AlertTriangle className="size-3.5 text-amber-400" /> {warnings.length} {t('ponto(s) para revisar')}</div>
            <ul className="space-y-0.5 pl-5">
              {warnings.map((w, i) => <li key={i} className="list-disc"><b className="font-medium">{w.where}:</b> {w.message}</li>)}
            </ul>
          </div>
        )}
        {email && !email.enabled && rules.some((r) => r.action === 'notify' && r.enabled) && <EmailOffAlert count={rules.filter((r) => r.action === 'notify' && r.enabled).length} />}

        <div className="mb-4 flex gap-1 border-b border-line">
          {([['mapa', t('Mapa do fluxo'), MapIcon], ['etapas', t('Etapas e regras'), ListOrdered]] as const).map(([id, label, I]) => (
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
            {/* Trilha numerada na ordem do quadro; etapas em paralelo dividem o mesmo degrau. */}
            <ol>
              {stageGroups(ordered).map((g, gi, all) => (
                <li key={g[0].id} className="relative flex gap-3 pb-4 last:pb-0">
                  <div className="relative flex w-7 shrink-0 justify-center">
                    <span className="relative z-[1] mt-3.5 grid size-7 place-items-center rounded-full border border-line bg-panel text-[11px] font-semibold text-dim">{gi + 1}</span>
                    {gi < all.length - 1 && <span className="absolute bottom-0 top-10 w-px bg-line" />}
                  </div>
                  <div className={clsx('min-w-0 flex-1', g.length > 1 && 'rounded-2xl border border-dashed border-sky-400/30 p-2')}>
                    {g.length > 1 && <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-sky-300"><ArrowRightLeft className="size-3" /> {t('Em paralelo: dividem a mesma coluna no quadro; uma regra decide para qual vai cada issue')}</div>}
                    <div className="space-y-2">
                      {g.map((s) => (
                        <StageCard key={s.id} readOnly={!canEdit} stage={s} stages={stages} rules={rules.filter((r) => r.stage === s.id && triggerOf(r.trigger).stage)}
                          onEdit={() => setEditingStage(s)} onDelete={() => removeStage(s)} onAddRule={() => newRule({ stage: s.id })}
                          onEditRule={setEditingRule} onToggleRule={toggle} onDeleteRule={remove} />
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </SortableContext>
        </DndContext>

        <section className="mt-8">
          <div className="mb-2 flex items-center gap-2">
            <Zap className="size-4 text-accent" />
            <h2 className="font-semibold">{t('Gatilhos do workspace')}</h2>
            {canEdit && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => newRule({ trigger: 'created', stage: '' })}><Plus className="size-3.5" /> {t('Regra')}</Button>}
          </div>
          <p className="mb-3 text-xs text-mute">{t('Regras que não dependem de etapa: issue criada (ex.: urgente avisa o time), comentário, fim da execução, prioridade, responsável, custo.')}</p>
          <div className="space-y-1.5">
            <RuleList readOnly={!canEdit} rules={globalRules} stages={stages} onEdit={setEditingRule} onToggle={toggle} onDelete={remove} />
            {!globalRules.length && <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-mute">{t('Nenhuma ainda. Ex.: “Issue criada com prioridade Urgente → notificar só administradores”.')}</div>}
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

// Uma etapa: cabeçalho com o que ela é e, embaixo, as regras agrupadas pelo
// momento em que valem. Etapa sem regra fica numa linha só.
function StageCard({ readOnly, stage: s, stages, rules, onEdit, onDelete, onAddRule, onEditRule, onToggleRule, onDeleteRule }: {
  readOnly?: boolean; stage: Stage; stages: Stage[]; rules: Rule[]; onEdit: () => void; onDelete: () => void; onAddRule: () => void;
  onEditRule: (r: Rule) => void; onToggleRule: (r: Rule) => void; onDeleteRule: (r: Rule) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id, disabled: readOnly });
  const by = (tt: RuleTrigger[]) => rules.filter((r) => tt.includes(r.trigger));
  const sections: { key: string; icon: typeof Lock; title: string; hint?: string; list: Rule[]; sequence?: boolean }[] = [
    { key: 'access', icon: ShieldCheck, title: t('Acesso e travas'), hint: t('valem o tempo todo'), list: by(['access']) },
    { key: 'enter', icon: LogIn, title: t('Ao entrar'), hint: readOnly ? t('nesta ordem') : t('nesta ordem · arraste para mudar'), list: by(['enter']), sequence: true },
    { key: 'leave', icon: LogOut, title: t('Ao sair'), list: by(['leave']) },
    { key: 'stale', icon: Timer, title: t('Se ficar parada'), list: by(['stale']) }
  ].filter((x) => x.list.length > 0);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('surface min-w-0', isDragging && 'relative z-10 shadow-pop')}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button {...attributes} {...listeners} aria-label={t('Arrastar')} className={clsx('grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-mute hover:text-fg active:cursor-grabbing', readOnly && 'hidden')}>
          <GripVertical className="size-4" />
        </button>
        <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: s.color }} />
        <StatusIcon status={s.id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{s.name}</span>
            <span className="text-[11px] text-mute">{s.system ? t('do sistema') : t('personalizada')}</span>
          </div>
          <p className="truncate text-xs text-mute">{s.system ? BUILTIN[s.id] : rules.length ? t('{0} regra(s)', rules.length) : t('Sem regras ainda.')}</p>
        </div>
        {!readOnly && <div className="flex shrink-0 items-center gap-0.5">
          <button title={t('Renomear ou mudar de lugar')} onClick={onEdit} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Settings2 className="size-4" /></button>
          {!s.system && <button title={t('Remover etapa')} onClick={onDelete} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-4" /></button>}
          <Button size="sm" variant="ghost" onClick={onAddRule}><Plus className="size-3.5" /> {t('Regra')}</Button>
        </div>}
      </div>
      {sections.length > 0 && (
        <div className="space-y-3 border-t border-line/70 px-3 pb-3 pt-2.5">
          {sections.map((x) => (
            <div key={x.key}>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-dim">
                <x.icon className="size-3 text-mute" /> {x.title}{x.hint && <span className="font-normal text-mute">· {x.hint}</span>}
              </div>
              <RuleList readOnly={readOnly} rules={x.list} stages={stages} sequence={x.sequence} onEdit={onEditRule} onToggle={onToggleRule} onDelete={onDeleteRule} />
            </div>
          ))}
        </div>
      )}
    </div>
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
  // Com filtro (ex.: só urgentes), o "Mover" pode não disparar e a sequência segue.
  const unconditional = (r: Rule) => !Object.values(r.conditions ?? {}).some((v) => (Array.isArray(v) ? v.length : !!v));
  const cut = sequence ? list.findIndex((r) => r.enabled && r.action === 'move' && unconditional(r)) : -1;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={list.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1.5">
          {list.map((r, i) => (
            <div key={r.id}>
              <RuleRow readOnly={readOnly} rule={r} stages={stages} index={sequence ? i : undefined} onEdit={() => onEdit(r)} onToggle={() => onToggle(r)} onDelete={() => onDelete(r)} />
              {cut >= 0 && i === cut && cut < list.length - 1 && (
                <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-amber-400/[0.07] px-2.5 py-1.5 text-[11px] text-amber-200">
                  <AlertTriangle className="size-3 text-amber-400" /> {t('Mover tira a issue da etapa: as regras abaixo não rodam. Arraste “Mover” para o fim.')}
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
        {t('O envio de e-mail está')} <b>{t('desligado')}</b>{count ? t(': {0} regra(s) de notificar não enviam nada', count) : t(': esta regra não vai enviar nada')} {t('até ele ser ligado.')}
        {!canSet && t(' Peça a um administrador para ligar.')}
      </span>
      {canSet && <Link to={`/w/${ws.key}/config/servidor`} className="rounded-lg bg-amber-400/15 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-400/25">{t('Ligar o envio de e-mail')}</Link>}
    </div>
  );
}


function RuleRow({ readOnly, rule: r, stages, index, onEdit, onToggle, onDelete }: { readOnly?: boolean; rule: Rule; stages: Stage[]; index?: number; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: r.id, disabled: readOnly });
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: labels = [] } = useLabels(ws.id);
  const { data: roles = [] } = useRoles();
  const { data: members = [] } = useMembers(ws.id);
  const A = actionOf(r.action);
  const c = r.config ?? {};
  const cond = r.conditions ?? {};
  const stageName = (id?: string) => stages.find((s) => s.id === id)?.name;
  const missing = (r.action === 'move' || r.action === 'approval') && !stageName(c.to || (r.action === 'approval' ? 'done' : ''));
  const who = [...roles.filter((x) => c.roles?.includes(x.id)).map((x) => t('perfil {0}', x.name)), ...members.filter((m) => c.users?.includes(m.id)).map((m) => m.name)].join(', ');
  const what = (() => {
    switch (r.action) {
      case 'notify': return t('E-mail para {0}', (TARGETS.find(([k]) => k === (c.to ?? 'requester'))?.[1] ?? '').toLowerCase());
      case 'webhook': return t('POST {0}', c.url);
      case 'move': return t('Mover para {0}', stageName(c.to) ?? t('uma etapa que foi removida'));
      case 'run_agent': return t('Rodar {0}{1}', agents.find((x) => x.id === c.agentId)?.name ?? t('o agente da issue'), c.request ? `: “${c.request}”` : '');
      case 'set_agent': return t('Agente: {0}', agents.find((x) => x.id === c.agentId)?.name ?? '?');
      case 'set_priority': return t('Prioridade: {0}', PRIORITIES.find((p) => p.id === c.priority)?.label ?? '?');
      case 'add_label': return t('Label: {0}', labels.find((l) => l.id === c.labelId)?.name ?? '?');
      case 'assign': return { creator: t('Responsável: quem criou'), requester: t('Responsável: quem pediu'), balance: t('Distribuir entre o grupo (quem tem menos issues)') }[c.mode ?? ''] ?? t('Responsável: {0}', who || '?');
      case 'comment': return t('Comentar: {0}', c.message);
      case 'open_pr': return t('Abrir PR para {0}{1}', c.base || t('a branch de destino'), c.draft ? t(' (rascunho)') : '');
      case 'merge': return t('Merge em {0}', c.base || t('a branch de destino'));
      case 'script': return t('Script: {0}', (c.script ?? '').split('\n')[0]);
      case 'allow_act': return t('Só {0} mexe nas issues daqui', who || '?');
      case 'allow_enter': return t('Só {0} traz issues para cá', who || '?');
      case 'approval': return t('{0} aprovação(ões) de {1} → {2}', c.approvals ?? 1, who || t('quem tem permissão de aprovar'), stageName(c.to || 'done') ?? t('etapa removida'));
      case 'lock_fields': return t('Travado: {0}', (c.fields ?? []).map((f) => LOCKS.find(([k]) => k === f)?.[1]).join(', '));
      case 'require': return t('Para entrar precisa: {0}', (c.requires ?? []).map((f) => REQUIRES.find(([k]) => k === f)?.[1].toLowerCase()).join(', '));
      case 'wip': return t('No máximo {0} issue(s) ao mesmo tempo', c.wip);
      case 'read_only': return t('Somente leitura: ninguém mexe mais (só o dono)');
      case 'responsible': return t('Responsáveis: {0}', who || '?');
    }
  })();
  const filters = [
    cond.priorities?.length ? cond.priorities.map((p) => PRIORITIES.find((x) => x.id === p)?.label).join('/') : '',
    cond.labels?.length ? t('{0} label(s)', cond.labels.length) : '',
    cond.outcomes?.length ? cond.outcomes.map((o) => OUTCOMES.find(([k]) => k === o)?.[1]).join('/') : '',
    cond.hours ? t('após {0} h', cond.hours) : '', cond.cost ? t('> US$ {0}', cond.cost) : '',
    cond.actorRoles?.length ? t('por perfil') : '', cond.agents?.length ? t('por agente') : ''
  ].filter(Boolean);
  const global = !triggerOf(r.trigger).stage;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('group relative flex items-center gap-2 rounded-lg border px-1.5 py-1.5', missing ? 'border-red-400/30 bg-red-400/[0.05]' : 'border-white/[0.06] bg-white/[0.02]', !r.enabled && 'opacity-50', isDragging && 'z-10 bg-panel shadow-pop')}>
      {!readOnly && (
        <button {...attributes} {...listeners} aria-label={t('Arrastar para mudar a ordem')} className="grid h-7 w-4 shrink-0 cursor-grab touch-none place-items-center rounded text-mute hover:text-fg active:cursor-grabbing">
          <GripVertical className="size-3.5" />
        </button>
      )}
      {index !== undefined && <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-dim">{index + 1}</span>}
      <span className={clsx('grid size-7 shrink-0 place-items-center rounded-lg', missing ? 'bg-red-400/10 text-red-400' : 'bg-accent/10 text-accent')}><A.icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          {global && <span className="text-mute">{triggerOf(r.trigger).label}:</span>}
          <span className="truncate">{what}</span>
          {filters.map((f) => <span key={f} className="rounded bg-white/5 px-1.5 text-[10px] text-dim">{f}</span>)}
        </div>
        {missing && <div className="truncate text-[11px] text-mute">{t('A etapa de destino foi removida: edite ou apague esta regra.')}</div>}
      </div>
      {readOnly ? <span className="pr-1.5 text-[11px] text-mute">{r.enabled ? t('ativa') : t('desligada')}</span> : <>
        <Toggle checked={r.enabled} onChange={onToggle} />
        <button onClick={onEdit} title={t('Editar')} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-3.5" /></button>
        <button onClick={onDelete} title={t('Apagar')} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-3.5" /></button>
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
        <button key={c.k + c.id} type="button" onClick={() => toggle(c.k, c.id)} title={t('Remover')}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs hover:border-red-400/50 hover:bg-red-400/10">
          {c.role ? <ShieldCheck className="size-3 text-accent" /> : <span className="grid size-3.5 place-items-center rounded-full bg-white/15 text-[8px] font-bold">{c.label[0]}</span>}
          {c.label}
        </button>
      ))}
      <Popover className="w-64 p-1.5" trigger={() => <button type="button" className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-dim hover:bg-hover"><Plus className="size-3" /> {t('Adicionar')}</button>}>
        {() => (
          <div className="max-h-72 overflow-y-auto">
            <div className="px-2 pb-1 pt-1 text-[11px] text-mute">{t('Perfis')}</div>
            {roles.map((x) => (
              <button key={x.id} type="button" onClick={() => toggle('roles', x.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]">
                <ShieldCheck className="size-3.5 text-mute" /> <span className="flex-1">{x.name}</span> {r.includes(x.id) && <Check className="size-3.5 text-accent" />}
              </button>
            ))}
            <div className="px-2 pb-1 pt-2 text-[11px] text-mute">{t('Pessoas com acesso a este workspace')}</div>
            {members.map((m) => (
              <button key={m.id} type="button" onClick={() => toggle('users', m.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]">
                <span className="grid size-4 place-items-center rounded-full bg-white/10 text-[9px] font-bold">{m.name[0]}</span>
                <span className="min-w-0 flex-1 truncate">{m.name} <span className="text-mute">· {m.isOwner ? t('dono') : m.roleName}</span></span>
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

// A etapa é só nome, lugar no fluxo e se fica em paralelo com a anterior.
// Quem pode, travas e aprovação são regras ("+ Regra" → "Sempre: acesso e travas").
function StageModal({ stage, stages, onClose, onSaved }: { stage: Partial<Stage> & { after?: string }; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs();
  const prev = stage.id ? stages[stages.findIndex((x) => x.id === stage.id) - 1]?.id : undefined;
  const [s, setS] = useState({ ...stage, after: stage.after ?? prev ?? '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: s.name, after: s.after !== prev ? s.after : '', parallel: !!s.parallel };
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
  const afterName = stages.find((x) => x.id === s.after)?.name;
  return (
    <Modal open onClose={onClose} title={s.id ? t('Etapa {0}', stage.name) : t('Nova etapa')} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancelar')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('Salvar')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('Nome')}><input autoFocus className="field-input" value={s.name ?? ''} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder={t('Ex.: Triagem, Desenvolvimento, QA, Homologação')} /></Field>
        {s.system && <p className="-mt-2 text-xs text-mute">{BUILTIN[s.id!]} {t('O nome pode mudar; o comportamento continua.')}</p>}
        <Field label={t('Vem depois de')}>
          <select className="field-input" value={s.after} onChange={(e) => setS({ ...s, after: e.target.value })}>
            {!prev && s.id && <option value="">{t('(primeira etapa)')}</option>}
            {stages.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <label className={clsx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', s.parallel ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-white/15')}>
          <Toggle checked={!!s.parallel} onChange={(parallel) => setS({ ...s, parallel })} />
          <span>
            <span className="block text-[13px] font-medium">{t('Em paralelo com')} {afterName ? `“${afterName}”` : t('a etapa anterior')}</span>
            <span className="block text-xs text-mute">{t('Fica lado a lado no fluxo e divide a mesma coluna no quadro. Ex.: depois de “Prioridade”, “Difícil” e “Médio” em paralelo, e uma regra manda cada issue para a sua.')}</span>
          </span>
        </label>
        <p className="text-xs text-mute">{t('Quem pode mexer, aprovação, travas e responsáveis ficam nas regras da etapa: depois de salvar, use')} <b className="font-medium text-dim">{t('+ Regra → Sempre: acesso e travas')}</b>.</p>
      </div>
    </Modal>
  );
}

// ---------- regra ----------

// Assistente de regra em passos curtos: Quando → O que fazer → Detalhes →
// Filtros (opcional). Escolher a ação já avança. Regras de acesso ("Sempre")
// não têm filtros: valem para toda issue da etapa.
type WizardStep = 0 | 1 | 2 | 3;
const ACCESS_DEFAULTS: Partial<Record<RuleAction, RuleConfig>> = { approval: { approvals: 1, to: 'done' }, wip: { wip: 3 } };

function RuleModal({ rule, stages, onClose, onSaved }: { rule: Partial<Rule>; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const { data: labels = [] } = useLabels(ws.id);
  const { data: roles = [] } = useRoles();
  const { data: email } = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<{ enabled: boolean }>('/settings/email') });
  const [r, setR] = useState<Partial<Rule>>({ ...rule, config: { ...(rule.config ?? {}) }, conditions: { ...(rule.conditions ?? {}) } });
  const [step, setStep] = useState<WizardStep>(rule.id ? 2 : 0);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const c = r.config ?? {};
  const cond = r.conditions ?? {};
  const setC = (p: Partial<RuleConfig>) => setR({ ...r, config: { ...c, ...p } });
  const setCond = (p: Partial<RuleConditions>) => setR({ ...r, conditions: { ...cond, ...p } });
  const tt = triggerOf(r.trigger ?? 'enter');
  const stageName = stages.find((s) => s.id === r.stage)?.name;
  const others = stages.filter((s) => s.id !== r.stage);
  const A = actionOf(r.action ?? 'notify');
  const nFilters = Object.values(cond).filter((v) => (Array.isArray(v) ? v.length : false)).length;
  const access = isAccess(r.trigger);
  const STEPS = access ? [t('Quando'), t('O que vale'), t('Detalhes')] : [t('Quando'), t('O que fazer'), t('Detalhes'), t('Filtros')];
  const pickTrigger = (id: RuleTrigger, stage: boolean) => {
    const next: Partial<Rule> = { ...r, trigger: id, stage: stage ? (r.stage || stages[0]?.id) : '' };
    // Trocar entre "acesso" e "automação" troca o catálogo de ações.
    if (isAccess(id) !== access) Object.assign(next, isAccess(id) ? { action: 'allow_act', config: {}, conditions: {} } : { action: 'notify', config: { to: 'requester' } });
    setR(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { trigger: r.trigger, stage: tt.stage ? r.stage : '', action: r.action, config: c, conditions: access ? {} : cond, enabled: r.enabled ?? true };
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
  const summary = [tt.label + (tt.stage && stageName ? ` · ${stageName}` : ''), A.label, '', nFilters ? t('{0} filtro(s)', nFilters) : t('sem filtros')];
  const onFail = (
    <Field label={t('Se falhar, mover para')} hint={t('opcional')}>
      <select className="field-input" value={c.onFail ?? ''} onChange={(e) => setC({ onFail: e.target.value })}>
        <option value="">{r.action === 'run_agent' ? t('Bloqueada (padrão)') : t('não mover (só registrar)')}</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Field>
  );

  const footer = (
    <>
      {step > 0 && <Button variant="ghost" onClick={() => setStep((step - 1) as WizardStep)}>{t('Voltar')}</Button>}
      <span className="flex-1" />
      {step === 0 && <Button variant="primary" onClick={() => setStep(1)}>{t('Continuar')}</Button>}
      {step === 2 && !access && <Button onClick={() => setStep(3)}>{t('Filtros')}{nFilters ? ` (${nFilters})` : ''}</Button>}
      {step >= 2 && <Button variant="primary" loading={busy} onClick={save}>{t('Salvar')}</Button>}
    </>
  );

  return (
    <Modal open onClose={onClose} title={r.id ? t('Editar regra') : t('Nova regra')} footer={footer}>
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
              <button key={x.id} type="button" onClick={() => pickTrigger(x.id, !!x.stage)}
                className={clsx('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition', r.trigger === x.id ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-white/[0.04]')}>
                <span className={clsx('grid size-4 place-items-center rounded-full border', r.trigger === x.id ? 'border-accent' : 'border-line')}>{r.trigger === x.id && <span className="size-2 rounded-full bg-accent" />}</span>
                <span className="min-w-0"><span className="block text-[13px]">{x.label}</span><span className="block text-[11px] text-mute">{x.hint}</span></span>
              </button>
            ))}
          </div>
          {(tt.stage || r.trigger === 'cost_over' || r.trigger === 'run_finished') && (
            <div className="grid gap-3 rounded-xl border border-white/[0.06] bg-black/10 p-3 sm:grid-cols-2">
              {tt.stage && (
                <Field label={t('Etapa')}>
                  <select className="field-input" value={r.stage} onChange={(e) => setR({ ...r, stage: e.target.value })}>
                    {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
              {r.trigger === 'stale' && <Field label={t('Parada há mais de (horas)')}><input type="number" min={1} className="field-input" value={cond.hours ?? 24} onChange={(e) => setCond({ hours: Number(e.target.value) })} /></Field>}
              {r.trigger === 'cost_over' && <Field label={t('Custo acima de (US$)')}><input type="number" min={0.1} step={0.5} className="field-input" value={cond.cost ?? 5} onChange={(e) => setCond({ cost: Number(e.target.value) })} /></Field>}
              {r.trigger === 'run_finished' && (
                <div className="flex flex-col gap-1.5 sm:col-span-2"><span className="text-xs font-medium text-dim">{t('Só quando o resultado for')}</span>
                  <Chips options={OUTCOMES} value={cond.outcomes ?? []} onChange={(outcomes) => setCond({ outcomes })} /></div>
              )}
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="grid grid-cols-2 gap-1.5">
          {(access ? ACCESS : ACTIONS).map((a) => (
            <button key={a.id} type="button" title={a.desc}
              onClick={() => { setR({ ...r, action: a.id, config: a.id === r.action ? c : a.id === 'notify' ? { to: 'requester' } : { ...(ACCESS_DEFAULTS[a.id] ?? {}) } }); setStep(2); }}
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
          {(r.action === 'allow_act' || r.action === 'allow_enter' || r.action === 'responsible') && <>
            <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty={t('escolha perfis e/ou pessoas')} />
            {r.action !== 'responsible' && <p className="text-xs text-mute">{t('Vale junto com as permissões do perfil, e o dono sempre pode. Ex.: estagiário e júnior com o mesmo perfil de permissões, mas só o estagiário mexe na Triagem e só o júnior no Desenvolvimento.')}</p>}
          </>}
          {r.action === 'approval' && <>
            <Field label={t('Quantas pessoas diferentes precisam aprovar')}>
              <input type="number" min={1} max={10} className="field-input w-32" value={c.approvals ?? 1} onChange={(e) => setC({ approvals: Math.min(10, Math.max(1, Number(e.target.value))) })} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-dim">{t('Quem pode aprovar')}</span>
              <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty={t('quem tem a permissão de aprovar')} />
            </div>
            <Field label={t('Aprovada, vai para')}>
              <select className="field-input" value={c.to || 'done'} onChange={(e) => setC({ to: e.target.value })}>
                {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-mute">
              {t('Na issue aparece o botão ✓ Aprovar. Cada pessoa aprova uma vez; com {0} aprovação(ões) diferente(s) a issue vai sozinha para {1}, e as regras de lá disparam.', c.approvals ?? 1, stages.find((x) => x.id === (c.to || 'done'))?.name ?? t('o destino'))}
              {(c.approvals ?? 1) > 1 && t(' Ex.: com 2, o tech lead aprova (1 de 2) e a issue espera; o PO aprova (2 de 2) e ela segue.')}
            </p>
          </>}
          {r.action === 'lock_fields' && <Chips options={LOCKS} value={c.fields ?? []} onChange={(fields) => setC({ fields })} />}
          {r.action === 'require' && <Chips options={REQUIRES} value={c.requires ?? []} onChange={(requires) => setC({ requires })} />}
          {r.action === 'wip' && (
            <Field label={t('Máximo de issues ao mesmo tempo')}>
              <input type="number" min={1} className="field-input w-32" value={c.wip ?? 3} onChange={(e) => setC({ wip: Math.max(1, Number(e.target.value)) })} />
            </Field>
          )}
          {r.action === 'notify' && <>
            {email && !email.enabled && <EmailOffAlert />}
            <Field label={t('Para quem')}>
              <select className="field-input" value={c.to ?? 'requester'} onChange={(e) => setC({ to: e.target.value, roles: [], users: [] })}>
                {TARGETS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            {(c.to === 'roles' || c.to === 'users') && (
              <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC(c.to === 'roles' ? { roles: w.roles } : { users: w.users })} empty={c.to === 'roles' ? t('escolha perfis') : t('escolha pessoas')} />
            )}
            <Field label={t('Mensagem')} hint={t('opcional')}><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder={t('Ex.: revisar até o fim do dia')} /></Field>
          </>}
          {r.action === 'webhook' && <>
            <Field label={t('URL')}><input className="field-input font-mono text-xs" value={c.url ?? ''} onChange={(e) => setC({ url: e.target.value })} placeholder={t('https://hooks.slack.com/services/…')} /></Field>
            <Field label={t('Mensagem')} hint={t('opcional')}><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} /></Field>
          </>}
          {r.action === 'comment' && <Field label={t('Comentário')}><textarea className="field-input" rows={3} value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder={t('Ex.: antes de aprovar, confira o checklist de segurança.')} /></Field>}
          {r.action === 'move' && <>
            <Field label={t('Mover para')}>
              <select className="field-input" value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value })}>
                <option value="" disabled>{t('escolha a etapa')}</option>
                {(tt.stage ? others : stages).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            {tt.stage && <p className="text-xs text-mute">{t('Mover encerra a sequência da etapa: deixe esta regra por último.')}</p>}
          </>}
          {r.action === 'assign' && <>
            <Field label={t('Quem vira responsável')}>
              <select className="field-input" value={c.mode ?? 'user'} onChange={(e) => setC({ mode: e.target.value, users: [], roles: [] })}>
                <option value="user">{t('Uma pessoa fixa')}</option>
                <option value="creator">{t('Quem criou a issue')}</option>
                <option value="requester">{t('Quem pediu')}</option>
                <option value="balance">{t('Distribuir: quem tiver menos issues no grupo')}</option>
              </select>
            </Field>
            {(c.mode ?? 'user') === 'user' && <WhoPicker value={{ users: c.users }} onChange={(w) => setC({ users: (w.users ?? []).slice(-1) })} empty={t('escolha a pessoa')} />}
            {c.mode === 'balance' && <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty={t('escolha perfis e/ou pessoas')} />}
          </>}
          {r.action === 'set_priority' && (
            <Field label={t('Prioridade')}>
              <select className="field-input" value={c.priority ?? 1} onChange={(e) => setC({ priority: Number(e.target.value) })}>
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
          )}
          {r.action === 'add_label' && (
            <Field label={t('Label')}>
              <select className="field-input" value={c.labelId ?? ''} onChange={(e) => setC({ labelId: e.target.value })}>
                <option value="" disabled>{t('escolha')}</option>
                {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          {(r.action === 'run_agent' || r.action === 'set_agent') && (
            <div className="flex flex-wrap gap-1.5">
              {r.action === 'run_agent' && <button type="button" onClick={() => setC({ agentId: '' })} className={clsx('rounded-full border px-3 py-1 text-xs', !c.agentId ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>{t('O da issue')}</button>}
              {agents.map((a) => (
                <button key={a.id} type="button" onClick={() => setC({ agentId: a.id })} className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', c.agentId === a.id ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>
                  <AgentIcon avatar={a.avatar} size={14} /> {a.name}
                </button>
              ))}
            </div>
          )}
          {r.action === 'run_agent' && <>
            <Field label={t('O que pedir')} hint={t('vazio = executar a issue')}><textarea className="field-input" rows={3} value={c.request ?? ''} onChange={(e) => setC({ request: e.target.value })} placeholder={t('Ex.: revise o diff e rode os testes.')} /></Field>
            <p className="text-xs text-mute">{tt.stage
              ? t('A issue fica nesta etapa enquanto o agente trabalha; as regras seguintes rodam quando ele terminar. Se ele precisar de alguém, a issue vai para Aguardando você.')
              : t('Pedido normal: a issue vai para Em andamento e segue o resultado do agente.')}</p>
            {tt.stage && onFail}
          </>}
          {r.action === 'open_pr' && <>
            <Field label={t('Branch de destino do PR')} hint={t('vazio = a de merge da issue')}><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder={t('main')} /></Field>
            <Toggle checked={!!c.draft} onChange={(draft) => setC({ draft })} label={t('Abrir como rascunho')} />
            {onFail}
          </>}
          {r.action === 'merge' && <Field label={t('Branch')} hint={t('vazio = a de merge de cada repositório')}><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder={t('main')} /></Field>}
          {r.action === 'script' && <>
            <Field label={t('Script (bash)')}>
              <textarea className="field-input font-mono text-xs" rows={4} spellCheck={false} value={c.script ?? ''} onChange={(e) => setC({ script: e.target.value })}
                placeholder={t('curl -X POST https://ci.exemplo.com/deploy -d "branch=$MULTICA_BRANCH"')} />
            </Field>
            <p className="text-[11px] text-mute">{t('MULTICA_ISSUE, _TITLE, _BRANCH, _STAGE, _FROM, _EVENT, _PRIORITY, _README, _WORKSPACE · até 10 min.')}</p>
            {onFail}
          </>}
        </div>
      )}

      {step === 3 && !access && (
        <div className="space-y-4">
          <p className="text-xs text-mute">{t('A regra só dispara se a issue atender a todos os filtros marcados. Sem filtros, vale para toda issue.')}</p>
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Prioridade é')}</span>
            <Chips options={PRIORITIES.map((p) => [p.id, p.label] as [number, string])} value={cond.priorities ?? []} onChange={(priorities) => setCond({ priorities })} /></div>
          {labels.length > 0 && <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Tem alguma destas labels')}</span>
            <Chips options={labels.map((l) => [l.id, l.name] as [string, string])} value={cond.labels ?? []} onChange={(l) => setCond({ labels: l })} /></div>}
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Agente da issue é')}</span>
            <Chips options={agents.map((a) => [a.id, a.name] as [string, string])} value={cond.agents ?? []} onChange={(a) => setCond({ agents: a })} /></div>
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Quem causou tem o perfil')}</span>
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
        toast('success', t('Fluxo copiado: {0} etapas e {1} regras', res.stages, res.rules));
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
    <Modal open onClose={onClose} title={t('Copiar fluxo para outro workspace')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('Cancelar')}</Button>
        {preview ? <Button variant="primary" loading={busy} onClick={() => run(false)}>{t('Substituir o fluxo do destino')}</Button>
          : <Button variant="primary" loading={busy} disabled={!to} onClick={() => run(true)}>{t('Ver o que muda')}</Button>}</>}>
      <div className="space-y-4">
        <Field label={t('Destino')}>
          <select className="field-input" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }}>
            <option value="" disabled>{t('escolha o workspace')}</option>
            {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <p className="text-xs text-mute">{t('Copia etapas, acessos, travas, aprovações e regras de')} <b className="text-dim">{ws.name}</b>{t('. Perfis e agentes são globais e vão iguais; pessoas sem acesso ao destino saem das listas, e labels são recriadas pelo nome. Issues do destino em etapas que deixarem de existir vão para o Backlog.')}</p>
        {preview && (
          <div className={clsx('rounded-xl border p-3 text-xs', preview.warnings.length ? 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200' : 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200')}>
            <div className="mb-1 font-medium">{preview.stages} {t('etapas e')} {preview.rules} {t('regras ·')} {preview.warnings.length ? t('{0} ajuste(s) automático(s):', preview.warnings.length) : t('nada a ajustar.')}</div>
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
        <span className="font-semibold">{t('Entrada de issues')}</span>
        <span className="text-xs text-mute">{t('webhook · e-mail encaminhado · formulários')}</span>
        <span className={clsx('ml-auto rounded-full px-2 py-0.5 text-[11px]', data.enabled ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/5 text-mute')}>{data.enabled ? t('ligada') : t('desligada')}</span>
        <ChevronDown className={clsx('size-4 text-mute transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-4 space-y-3 text-[13px]">
          <p className="text-xs text-mute">{t('Um endereço que cria issues sozinho. Use para “quando cair um e-mail na caixa”: encaminhe com Cloudflare Email Routing, n8n, Zapier ou Make para este endereço. Aceita')} <code>{t('{title, description, priority}')}</code> {t('ou')} <code>{t('{subject, text, from}')}</code>{t('. A issue dispara as regras de “Issue criada”.')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <Toggle checked={data.enabled} onChange={(enabled) => save({ enabled, stage: data.stage })} label={t('Ligada')} />
            <Field label={t('Cria em')} className="w-56">
              <select className="field-input" value={data.stage} onChange={(e) => save({ enabled: data.enabled, stage: e.target.value })}>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          {url && (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-black/30 px-3 py-2 font-mono text-[11px]">{url}</code>
              <Button size="sm" onClick={() => { navigator.clipboard?.writeText(url); toast('success', t('Endereço copiado')); }}><Copy className="size-3.5" /></Button>
              <Button size="sm" variant="ghost" title={t('Gerar outro endereço (o antigo para de funcionar)')} onClick={() => confirm(t('Gerar um endereço novo? O atual para de funcionar.')) && save({ enabled: true, stage: data.stage, rotate: true })}><RefreshCw className="size-3.5" /></Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
