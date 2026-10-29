import { useMemo, useState } from 'react';
import { FlowMap } from './FlowMap';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle, ArrowRightLeft, CheckCircle2, CircleStop, ListChecks, ListOrdered, LogIn, LogOut, Map as MapIcon, Bot, Check, Copy, Flag, GitMerge, GitPullRequest,
  GripVertical, Inbox, Lock, Mail, MessageSquare, Pencil, Plus, Settings2, ShieldCheck, Sparkles, SquareTerminal, Tag, Timer, Trash2,
  UserCheck, Users, Webhook, Workflow, Zap
} from 'lucide-react';
import { useWs } from '../components/Layout';
import { Button, Field, Modal, PageHeader, Popover, StatusIcon, Toggle, useToast, useConfirm } from '../components/ui';
import { AgentIcon } from '../components/AgentIcon';
import { api } from '../lib/api';
import { PRIORITIES, localizeStages, stageGroups } from '../lib/constants';
import { useAgents, useCan, useLabels, useMembers, useRoles, useRules, useStages, useWorkspaces } from '../lib/queries';
import type { LockField, Requirement, Rule, RuleAction, RuleConditions, RuleConfig, RuleTrigger, Stage, Who, WorkflowWarning } from '../lib/types';
import { t } from '../lib/i18n';

// ---------- catalogs ----------

const TRIGGERS: { id: RuleTrigger; label: string; stage?: boolean; hint: string }[] = [
  { id: 'access', label: t('Always: access & locks'), stage: true, hint: t('who works on or brings issues, approval, locks, requirements, limit, owners') },
  { id: 'enter', label: t('Enters the stage'), stage: true, hint: t('from the board, the agent or another rule') },
  { id: 'leave', label: t('Leaves the stage'), stage: true, hint: t('to any other') },
  { id: 'stale', label: t('Sits idle in the stage'), stage: true, hint: t('for X hours without leaving') },
  { id: 'created', label: t('Issue created'), hint: t('on the board, by webhook or forwarded email') },
  { id: 'commented', label: t('New comment'), hint: t('from a person') },
  { id: 'run_started', label: t('Agent started'), hint: t('requested from the board, a comment, a reply or a rule') },
  { id: 'run_finished', label: t('Agent run finished'), hint: t('done, waiting, incomplete, failed or stopped') },
  { id: 'merged', label: t('Merged'), hint: t('by the button or by a rule') },
  { id: 'merge_conflict', label: t('Merge conflict'), hint: t('nothing was published') },
  { id: 'rule_failed', label: t('A rule failed'), hint: t('agent without a repository, script, merge, PR… (when the rule has no “if it fails, move to”)') },
  { id: 'assigned', label: t('Assignee set'), hint: t('someone took ownership of the issue') },
  { id: 'priority_changed', label: t('Priority changed'), hint: t('use the filter to catch only urgent ones') },
  { id: 'cost_over', label: t('Cost went over an amount'), hint: t('sum of the runs in US$') }
];
const triggerOf = (tt: RuleTrigger) => TRIGGERS.find((x) => x.id === tt) ?? TRIGGERS[0];

const ACTIONS: { id: RuleAction; icon: typeof Mail; label: string; desc: string; group: string }[] = [
  { id: 'notify', icon: Mail, label: t('Notify by email'), desc: t('Assignee, team, admins, roles or people.'), group: t('Notify') },
  { id: 'webhook', icon: Webhook, label: t('Webhook'), desc: t('Slack, Discord, Teams, n8n…'), group: t('Notify') },
  { id: 'comment', icon: MessageSquare, label: t('Comment'), desc: t('Leaves a fixed instruction on the issue.'), group: t('Notify') },
  { id: 'move', icon: ArrowRightLeft, label: t('Move to stage'), desc: t('Routes the issue.'), group: t('Organize') },
  { id: 'assign', icon: UserCheck, label: t('Set assignee'), desc: t('Fixed, the creator, or spread across a group.'), group: t('Organize') },
  { id: 'set_priority', icon: Flag, label: t('Set priority'), desc: t('E.g. a customer issue becomes urgent.'), group: t('Organize') },
  { id: 'add_label', icon: Tag, label: t('Add label'), desc: t('Tags the issue.'), group: t('Organize') },
  { id: 'set_agent', icon: Bot, label: t('Set agent'), desc: t('Picks the issue\'s agent.'), group: t('AI & code') },
  { id: 'run_agent', icon: Sparkles, label: t('Run agent'), desc: t('AI review, tests, documentation…'), group: t('AI & code') },
  { id: 'open_pr', icon: GitPullRequest, label: t('Open pull request'), desc: t('GitHub, via gh.'), group: t('AI & code') },
  { id: 'merge', icon: GitMerge, label: t('Merge'), desc: t('All or nothing across repositories.'), group: t('AI & code') },
  { id: 'script', icon: SquareTerminal, label: t('Run script'), desc: t('Bash with FOREMAN_* variables.'), group: t('AI & code') },
  { id: 'stop_agent', icon: CircleStop, label: t('Stop the agent'), desc: t('Cancels the running execution.'), group: t('AI & code') }
];
// Access rules: they don't "run"; they apply the whole time the issue is in the stage.
const ACCESS: { id: RuleAction; icon: typeof Mail; label: string; desc: string }[] = [
  { id: 'allow_act', icon: ShieldCheck, label: t('Who works on issues'), desc: t('Only these people edit, comment, run the agent and move the issue out of here.') },
  { id: 'allow_enter', icon: LogIn, label: t('Who brings issues here'), desc: t('Only these people move (or create) issues in this stage.') },
  { id: 'approval', icon: UserCheck, label: t('Require approval'), desc: t('The issue only moves on when different people give the ✓.') },
  { id: 'lock_fields', icon: Lock, label: t('Lock fields'), desc: t('Nobody changes these fields while the issue is here.') },
  { id: 'require', icon: ListChecks, label: t('Entry requirements'), desc: t('The issue only enters if it has what\'s checked.') },
  { id: 'wip', icon: Inbox, label: t('Issue limit'), desc: t('Maximum issues at the same time in this stage.') },
  { id: 'read_only', icon: Lock, label: t('Read-only'), desc: t('Once here, nobody changes it. Only the owner, as an emergency exit.') },
  { id: 'responsible', icon: Users, label: t('Stage owners'), desc: t('They receive the “stage owners” email.') },
  { id: 'close', icon: CheckCircle2, label: t('Close the issue'), desc: t('Once here, it counts as done (resolved) or cancelled: it leaves the open issues and enters analytics.') }
];
const isAccess = (tt?: RuleTrigger) => tt === 'access';
const actionOf = (id: RuleAction) => ACTIONS.find((a) => a.id === id) ?? ACCESS.find((a) => a.id === id) ?? ACTIONS[0];

const TARGETS: [string, string][] = [
  ['requester', t('The requester (last request to the agent)')],
  ['creator', t('Whoever created the issue')],
  ['assignee', t('The issue\'s assignee')],
  ['responsible', t('The stage owners')],
  ['team', t('The team (the whole workspace)')],
  ['admins', t('Administrators only')],
  ['roles', t('Chosen roles')],
  ['users', t('Chosen users')]
];

const LOCKS: [LockField, string][] = [
  ['title', t('Title')], ['description', t('Description and README')], ['priority', t('Priority')], ['labels', t('Labels')],
  ['agent', t('Agent')], ['repos', t('Repositories')], ['assignee', t('Assignee')]
];
const REQUIRES: [Requirement, string][] = [
  ['agent', t('Has an agent')], ['assignee', t('Has an assignee')], ['description', t('Has a description')], ['changes', t('Has code changes')]
];
const OUTCOMES: [string, string][] = [['done', t('Done')], ['waiting', t('Waiting for someone')], ['incomplete', t('Incomplete')], ['failed', t('Failed')], ['cancelled', t('Stopped')]];

// ---------- page ----------

export function WorkflowPage() {
  const ask = useConfirm();
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
  // Only with "View the workflow": everything read-only.
  const canEdit = useCan('workflow.manage');
  const [view, setView] = useState<'map' | 'stages' | 'general'>(() => {
    try {
      return (localStorage.getItem('foreman.flowView') as 'map' | 'stages' | 'general') || 'map';
    } catch {
      return 'map';
    }
  });
  const pickView = (v: 'map' | 'stages' | 'general') => {
    setView(v);
    try {
      localStorage.setItem('foreman.flowView', v);
    } catch {
      /* no storage */
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
    if (!(await ask({ title: t('Remove this rule?'), danger: true }))) return;
    await api.del(`/rules/${r.id}`);
    refresh();
  };
  const removeStage = async (s: Stage) => {
    const first = stages.find((x) => x.id !== s.id)?.name ?? '';
    if (!(await ask({ title: t('Remove the stage "{0}"?', s.name), message: t('Its issues go to "{0}" and its rules are deleted.', first), danger: true }))) return;
    try {
      await api.del(`/workspaces/${ws.id}/stages/${s.id}`);
    } catch (err) {
      toast('error', (err as Error).message);
      return;
    }
    refresh();
    qc.invalidateQueries({ queryKey: ['issues', ws.id] });
  };
  const newRule = (p: Partial<Rule>) => setEditingRule({ trigger: 'enter', action: 'notify', config: { to: 'requester' }, conditions: {}, enabled: true, ...p });
  const globalRules = rules.filter((r) => !triggerOf(r.trigger).stage);

  return (
    <div className="h-full overflow-y-auto">
      <div className="page">
        <PageHeader
          icon={Workflow}
          title={t('Workflow & automations')}
          description={t('The board\'s stages, who can do what in each one, and the rules that run on their own. A stage\'s rules run top to bottom{0}.', canEdit ? t('; drag stages and rules to change the order') : '')}
          actions={canEdit ? <>
            <Button onClick={() => setCopying(true)}><Copy className="size-4" /> {t('Copy to…')}</Button>
            <Button variant="primary" onClick={() => setEditingStage({ after: stages[stages.length - 1]?.id ?? '' })}><Plus className="size-4" /> {t('New stage')}</Button>
          </> : <span className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-mute">{t('read-only')}</span>}
        />

        {warnings.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-200">
            <div className="mb-1.5 flex items-center gap-2 font-medium"><AlertTriangle className="size-3.5 text-amber-400" /> {warnings.length} {t('item(s) to review')}</div>
            <ul className="space-y-0.5 pl-5">
              {warnings.map((w, i) => <li key={i} className="list-disc"><b className="font-medium">{w.where}:</b> {w.message}</li>)}
            </ul>
          </div>
        )}
        {email && !email.enabled && rules.some((r) => r.action === 'notify' && r.enabled) && <EmailOffAlert count={rules.filter((r) => r.action === 'notify' && r.enabled).length} />}

        <div className="mb-4 flex gap-1 border-b border-line">
          {([['map', t('Flow map'), MapIcon], ['stages', t('Stages & rules'), ListOrdered], ['general', t('General rules'), Zap]] as const).map(([id, label, I]) => (
            <button key={id} onClick={() => pickView(id)}
              className={clsx('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors', view === id ? 'border-accent font-medium text-fg' : 'border-transparent text-mute hover:text-fg')}>
              <I className="size-3.5" /> {label}
            </button>
          ))}
        </div>

        {view === 'map' && <FlowMap stages={stages} rules={rules} />}

        {view === 'stages' && <>
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
                    {g.length > 1 && <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-sky-300"><ArrowRightLeft className="size-3" /> {t('In parallel: they share one board column; a rule decides where each issue goes')}</div>}
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

        </>}

        {view === 'general' && (
          <section>
            <div className="mb-4 flex flex-wrap items-start gap-3">
              <p className="min-w-0 flex-1 text-xs text-mute">{t('Stage rules fire when the issue enters, leaves or sits idle in a stage. General rules fire on an event, wherever the issue is: the agent started or finished, merge, conflict, issue created, comment, priority, assignee, cost. To apply only from certain stages, use the “the issue is in the stage” filter.')}</p>
              {canEdit && <Button size="sm" variant="primary" onClick={() => newRule({ trigger: 'run_finished', stage: '' })}><Plus className="size-3.5" /> {t('General rule')}</Button>}
            </div>
            {!globalRules.length && <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-mute">{t('None yet. E.g. “Issue created with Urgent priority → notify administrators only”.')}</div>}
            {/* One box per trigger, in the order they happen. */}
            <div className="space-y-3">
              {TRIGGERS.filter((x) => !x.stage).map((x) => {
                const list = globalRules.filter((r) => r.trigger === x.id);
                if (!list.length) return null;
                return (
                  <div key={x.id} className="surface p-3">
                    <div className="mb-2 flex items-baseline gap-2 px-1">
                      <span className="text-[13px] font-semibold">{x.label}</span>
                      <span className="text-[11px] text-mute">{x.hint}</span>
                      {canEdit && <button type="button" onClick={() => newRule({ trigger: x.id, stage: '' })} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-mute hover:bg-white/5 hover:text-fg"><Plus className="size-3" /> {t('Rule')}</button>}
                    </div>
                    <RuleList readOnly={!canEdit} rules={list} stages={stages} onEdit={setEditingRule} onToggle={toggle} onDelete={remove} />
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
      {editingRule && <RuleModal rule={editingRule} stages={stages} onClose={() => setEditingRule(null)} onSaved={refresh} />}
      {editingStage && <StageModal stage={editingStage} stages={stages} onClose={() => setEditingStage(null)} onSaved={refresh} />}
      {copying && <CopyModal onClose={() => setCopying(false)} />}
    </div>
  );
}

// ---------- stage card ----------

// A stage: a header with what it is and, below, the rules grouped by the moment they
// apply. A stage without rules fits on one line.
function StageCard({ readOnly, stage: s, stages, rules, onEdit, onDelete, onAddRule, onEditRule, onToggleRule, onDeleteRule }: {
  readOnly?: boolean; stage: Stage; stages: Stage[]; rules: Rule[]; onEdit: () => void; onDelete: () => void; onAddRule: () => void;
  onEditRule: (r: Rule) => void; onToggleRule: (r: Rule) => void; onDeleteRule: (r: Rule) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id, disabled: readOnly });
  const by = (tt: RuleTrigger[]) => rules.filter((r) => tt.includes(r.trigger));
  const sections: { key: string; icon: typeof Lock; title: string; hint?: string; list: Rule[]; sequence?: boolean }[] = [
    { key: 'access', icon: ShieldCheck, title: t('Access & locks'), hint: t('always apply'), list: by(['access']) },
    { key: 'enter', icon: LogIn, title: t('On enter'), hint: readOnly ? t('in this order') : t('in this order · drag to change'), list: by(['enter']), sequence: true },
    { key: 'leave', icon: LogOut, title: t('On leave'), list: by(['leave']) },
    { key: 'stale', icon: Timer, title: t('If it sits idle'), list: by(['stale']) }
  ].filter((x) => x.list.length > 0);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('surface min-w-0', isDragging && 'relative z-10 shadow-pop')}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button {...attributes} {...listeners} aria-label={t('Drag')} className={clsx('grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded text-mute hover:text-fg active:cursor-grabbing', readOnly && 'hidden')}>
          <GripVertical className="size-4" />
        </button>
        <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: s.color }} />
        <StatusIcon status={s.id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{s.name}</span>
            {s.policy?.close && <span className="text-[11px] text-mute">{s.policy.close === 'done' ? t('closes as done') : t('closes as cancelled')}</span>}
          </div>
          <p className="truncate text-xs text-mute">{rules.length ? t('{0} rule(s)', rules.length) : t('No rules yet.')}</p>
        </div>
        {!readOnly && <div className="flex shrink-0 items-center gap-0.5">
          <button title={t('Rename or move')} onClick={onEdit} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Settings2 className="size-4" /></button>
          {stages.length > 1 && <button title={t('Remove stage')} onClick={onDelete} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-4" /></button>}
          <Button size="sm" variant="ghost" onClick={onAddRule}><Plus className="size-3.5" /> {t('Rule')}</Button>
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

// A sortable list of rules: the order is the order they run in.
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
  // A "Move" in the middle cuts the sequence: it warns which rules would never run.
  // With a filter (e.g. only urgent ones), the "Move" may not fire and the sequence goes on.
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
                  <AlertTriangle className="size-3 text-amber-400" /> {t('Move takes the issue out of the stage: the rules below won\'t run. Drag “Move” to the end.')}
                </div>
              )}
            </div>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// E-mail off on the server: no notify rule sends anything.
function EmailOffAlert({ count }: { count?: number }) {
  const { ws } = useWs();
  const canSet = useCan('settings.manage');
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2.5 text-xs text-amber-200">
      <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
      <span className="min-w-0 flex-1">
        {t('Email sending is')} <b>{t('off')}</b>{count ? t(': {0} notify rule(s) send nothing', count) : t(': this rule won\'t send anything')} {t('until it\'s turned on.')}
        {!canSet && t(' Ask an administrator to turn it on.')}
      </span>
      {canSet && <Link to={`/w/${ws.key}/config/server`} className="rounded-lg bg-amber-400/15 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-400/25">{t('Turn on email sending')}</Link>}
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
  const missing = (r.action === 'move' || r.action === 'approval') && !stageName(c.to);
  const who = [...roles.filter((x) => c.roles?.includes(x.id)).map((x) => t('role {0}', x.name)), ...members.filter((m) => c.users?.includes(m.id)).map((m) => m.name)].join(', ');
  const what = (() => {
    switch (r.action) {
      case 'notify': return t('Email {0}', (TARGETS.find(([k]) => k === (c.to ?? 'requester'))?.[1] ?? '').toLowerCase());
      case 'webhook': return t('POST {0}', c.url);
      case 'move': return t('Move to {0}', stageName(c.to) ?? t('a stage that was removed'));
      case 'run_agent': return t('Run {0}{1}', agents.find((x) => x.id === c.agentId)?.name ?? t('the issue\'s agent'), c.request ? `: “${c.request}”` : '');
      case 'set_agent': return t('Agent: {0}', agents.find((x) => x.id === c.agentId)?.name ?? '?');
      case 'set_priority': return t('Priority: {0}', PRIORITIES.find((p) => p.id === c.priority)?.label ?? '?');
      case 'add_label': return t('Label: {0}', labels.find((l) => l.id === c.labelId)?.name ?? '?');
      case 'assign': return { creator: t('Assignee: the creator'), requester: t('Assignee: the requester'), balance: t('Spread across the group (fewest issues)') }[c.mode ?? ''] ?? t('Assignee: {0}', who || '?');
      case 'comment': return t('Comment: {0}', c.message);
      case 'open_pr': return t('Open PR into {0}{1}', c.base || t('the target branch'), c.draft ? t(' (draft)') : '');
      case 'merge': return t('Merge into {0}', c.base || t('the target branch'));
      case 'script': return t('Script: {0}', (c.script ?? '').split('\n')[0]);
      case 'allow_act': return t('Only {0} works on issues here', who || '?');
      case 'allow_enter': return t('Only {0} brings issues here', who || '?');
      case 'approval': return t('{0} approval(s) from {1} → {2}', c.approvals ?? 1, who || t('anyone allowed to approve'), stageName(c.to) ?? t('removed stage'));
      case 'lock_fields': return t('Locked: {0}', (c.fields ?? []).map((f) => LOCKS.find(([k]) => k === f)?.[1]).join(', '));
      case 'require': return t('To enter it needs: {0}', (c.requires ?? []).map((f) => REQUIRES.find(([k]) => k === f)?.[1].toLowerCase()).join(', '));
      case 'wip': return t('At most {0} issue(s) at the same time', c.wip);
      case 'read_only': return t('Read-only: nobody changes it anymore (owner only)');
      case 'responsible': return t('Owners: {0}', who || '?');
      case 'stop_agent': return t('Stop the agent');
      case 'close': return c.kind === 'cancelled' ? t('Close as cancelled') : t('Close as done (resolved)');
    }
  })();
  const filters = [
    cond.stages?.length ? t('in {0}', cond.stages.map((id) => stageName(id) ?? '?').join('/')) : '',
    cond.priorities?.length ? cond.priorities.map((p) => PRIORITIES.find((x) => x.id === p)?.label).join('/') : '',
    cond.labels?.length ? t('{0} label(s)', cond.labels.length) : '',
    cond.outcomes?.length ? cond.outcomes.map((o) => OUTCOMES.find(([k]) => k === o)?.[1]).join('/') : '',
    cond.hours ? t('after {0} h', cond.hours) : '', cond.cost ? t('> US$ {0}', cond.cost) : '',
    cond.actorRoles?.length ? t('by role') : '', cond.agents?.length ? t('by agent') : ''
  ].filter(Boolean);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('group relative flex items-center gap-2 rounded-lg border px-1.5 py-1.5', missing ? 'border-red-400/30 bg-red-400/[0.05]' : 'border-white/[0.06] bg-white/[0.02]', !r.enabled && 'opacity-50', isDragging && 'z-10 bg-panel shadow-pop')}>
      {!readOnly && (
        <button {...attributes} {...listeners} aria-label={t('Drag to reorder')} className="grid h-7 w-4 shrink-0 cursor-grab touch-none place-items-center rounded text-mute hover:text-fg active:cursor-grabbing">
          <GripVertical className="size-3.5" />
        </button>
      )}
      {index !== undefined && <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[10px] font-semibold text-dim">{index + 1}</span>}
      <span className={clsx('grid size-7 shrink-0 place-items-center rounded-lg', missing ? 'bg-red-400/10 text-red-400' : 'bg-accent/10 text-accent')}><A.icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <span className="truncate">{what}</span>
          {filters.map((f) => <span key={f} className="rounded bg-white/5 px-1.5 text-[10px] text-dim">{f}</span>)}
        </div>
        {missing && <div className="truncate text-[11px] text-mute">{t('The target stage was removed: edit or delete this rule.')}</div>}
      </div>
      {readOnly ? <span className="pr-1.5 text-[11px] text-mute">{r.enabled ? t('on') : t('off')}</span> : <>
        <Toggle checked={r.enabled} onChange={onToggle} />
        <button onClick={onEdit} title={t('Edit')} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-3.5" /></button>
        <button onClick={onDelete} title={t('Delete')} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-3.5" /></button>
      </>}
    </div>
  );
}

// ---------- who: roles + people with access ----------

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
        <button key={c.k + c.id} type="button" onClick={() => toggle(c.k, c.id)} title={t('Remove')}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs hover:border-red-400/50 hover:bg-red-400/10">
          {c.role ? <ShieldCheck className="size-3 text-accent" /> : <span className="grid size-3.5 place-items-center rounded-full bg-white/15 text-[8px] font-bold">{c.label[0]}</span>}
          {c.label}
        </button>
      ))}
      <Popover className="w-64 p-1.5" trigger={() => <button type="button" className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-dim hover:bg-hover"><Plus className="size-3" /> {t('Add')}</button>}>
        {() => (
          <div className="max-h-72 overflow-y-auto">
            <div className="px-2 pb-1 pt-1 text-[11px] text-mute">{t('Roles')}</div>
            {roles.map((x) => (
              <button key={x.id} type="button" onClick={() => toggle('roles', x.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]">
                <ShieldCheck className="size-3.5 text-mute" /> <span className="flex-1">{x.name}</span> {r.includes(x.id) && <Check className="size-3.5 text-accent" />}
              </button>
            ))}
            <div className="px-2 pb-1 pt-2 text-[11px] text-mute">{t('People with access to this workspace')}</div>
            {members.map((m) => (
              <button key={m.id} type="button" onClick={() => toggle('users', m.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.06]">
                <span className="grid size-4 place-items-center rounded-full bg-white/10 text-[9px] font-bold">{m.name[0]}</span>
                <span className="min-w-0 flex-1 truncate">{m.name} <span className="text-mute">· {m.isOwner ? t('owner') : m.roleName}</span></span>
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

// The stage is just a name, a place in the workflow and whether it runs in parallel with the
// previous one. Who may, locks and approval are rules ("+ Rule" → "Always: access and locks").
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
    <Modal open onClose={onClose} title={s.id ? t('Stage {0}', stage.name) : t('New stage')} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('Name')}><input autoFocus className="field-input" value={s.name ?? ''} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder={t('E.g. Triage, Development, QA, Staging')} /></Field>
        <Field label={t('Comes after')}>
          <select className="field-input" value={s.after} onChange={(e) => setS({ ...s, after: e.target.value })}>
            {!prev && s.id && <option value="">{t('(first stage)')}</option>}
            {stages.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <label className={clsx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', s.parallel ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-white/15')}>
          <Toggle checked={!!s.parallel} onChange={(parallel) => setS({ ...s, parallel })} />
          <span>
            <span className="block text-[13px] font-medium">{t('In parallel with')} {afterName ? `“${afterName}”` : t('the previous stage')}</span>
            <span className="block text-xs text-mute">{t('Sits side by side in the flow and shares one board column. E.g. after “Priority”, “Hard” and “Medium” in parallel, and a rule sends each issue to its own.')}</span>
          </span>
        </label>
        <p className="text-xs text-mute">{t('Who can work on it, approval, locks and owners live in the stage\'s rules: after saving, use')} <b className="font-medium text-dim">{t('+ Rule → Always: access & locks')}</b>.</p>
      </div>
    </Modal>
  );
}

// ---------- regra ----------

// A rule wizard in short steps: When → What to do → Details → Filters (optional).
// Choosing the action already moves on. Access rules ("Always") have no filters:
// they apply to every issue in the stage.
type WizardStep = 0 | 1 | 2 | 3;
const ACCESS_DEFAULTS: Partial<Record<RuleAction, RuleConfig>> = { approval: { approvals: 1 }, wip: { wip: 3 }, close: { kind: 'done' } };

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
  const STEPS = access ? [t('When'), t('What applies'), t('Details')] : [t('When'), t('What to do'), t('Details'), t('Filters')];
  const pickTrigger = (id: RuleTrigger, stage: boolean) => {
    const next: Partial<Rule> = { ...r, trigger: id, stage: stage ? (r.stage || stages[0]?.id) : '' };
    // Switching between "access" and "automation" switches the action catalog.
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
  const summary = [tt.label + (tt.stage && stageName ? ` · ${stageName}` : ''), A.label, '', nFilters ? t('{0} filter(s)', nFilters) : t('no filters')];
  const onFail = (
    <Field label={t('If it fails, move to')} hint={t('optional')}>
      <select className="field-input" value={c.onFail ?? ''} onChange={(e) => setC({ onFail: e.target.value })}>
        <option value="">{r.action === 'run_agent' ? t('Blocked (default)') : t('don\'t move (just log)')}</option>
        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Field>
  );

  const footer = (
    <>
      {step > 0 && <Button variant="ghost" onClick={() => setStep((step - 1) as WizardStep)}>{t('Back')}</Button>}
      <span className="flex-1" />
      {step === 0 && <Button variant="primary" onClick={() => setStep(1)}>{t('Continue')}</Button>}
      {step === 2 && !access && <Button onClick={() => setStep(3)}>{t('Filters')}{nFilters ? ` (${nFilters})` : ''}</Button>}
      {step >= 2 && <Button variant="primary" loading={busy} onClick={save}>{t('Save')}</Button>}
    </>
  );

  return (
    <Modal open onClose={onClose} title={r.id ? t('Edit rule') : t('New rule')} footer={footer}>
      {/* Steps: clickable to jump straight there; each shows what was already chosen. */}
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
                <Field label={t('Stage')}>
                  <select className="field-input" value={r.stage} onChange={(e) => setR({ ...r, stage: e.target.value })}>
                    {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
              {r.trigger === 'stale' && <Field label={t('Idle for more than (hours)')}><input type="number" min={1} className="field-input" value={cond.hours ?? 24} onChange={(e) => setCond({ hours: Number(e.target.value) })} /></Field>}
              {r.trigger === 'cost_over' && <Field label={t('Cost above (US$)')}><input type="number" min={0.1} step={0.5} className="field-input" value={cond.cost ?? 5} onChange={(e) => setCond({ cost: Number(e.target.value) })} /></Field>}
              {r.trigger === 'run_finished' && (
                <div className="flex flex-col gap-1.5 sm:col-span-2"><span className="text-xs font-medium text-dim">{t('Only when the result is')}</span>
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
            <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty={t('choose roles and/or people')} />
            {r.action !== 'responsible' && <p className="text-xs text-mute">{t('Applies on top of role permissions, and the owner always can. E.g. intern and junior share the same permission role, but only the intern works in Triage and only the junior in Development.')}</p>}
          </>}
          {r.action === 'approval' && <>
            <Field label={t('How many different people must approve')}>
              <input type="number" min={1} max={10} className="field-input w-32" value={c.approvals ?? 1} onChange={(e) => setC({ approvals: Math.min(10, Math.max(1, Number(e.target.value))) })} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-dim">{t('Who can approve')}</span>
              <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty={t('anyone with the approve permission')} />
            </div>
            <Field label={t('Once approved, goes to')}>
              <select className="field-input" value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value })}>
                <option value="" disabled>{t('choose the stage')}</option>
                {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-mute">
              {t('The issue shows a ✓ Approve button. Each person approves once; with {0} different approval(s) the issue moves to {1} on its own, and that stage\'s rules fire.', c.approvals ?? 1, stages.find((x) => x.id === c.to)?.name ?? t('the destination'))}
              {(c.approvals ?? 1) > 1 && t(' E.g. with 2, the tech lead approves (1 of 2) and the issue waits; the PO approves (2 of 2) and it moves on.')}
            </p>
          </>}
          {r.action === 'lock_fields' && <Chips options={LOCKS} value={c.fields ?? []} onChange={(fields) => setC({ fields })} />}
          {r.action === 'require' && <Chips options={REQUIRES} value={c.requires ?? []} onChange={(requires) => setC({ requires })} />}
          {r.action === 'wip' && (
            <Field label={t('Maximum issues at the same time')}>
              <input type="number" min={1} className="field-input w-32" value={c.wip ?? 3} onChange={(e) => setC({ wip: Math.max(1, Number(e.target.value)) })} />
            </Field>
          )}
          {r.action === 'notify' && <>
            {email && !email.enabled && <EmailOffAlert />}
            <Field label={t('To whom')}>
              <select className="field-input" value={c.to ?? 'requester'} onChange={(e) => setC({ to: e.target.value, roles: [], users: [] })}>
                {TARGETS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            {(c.to === 'roles' || c.to === 'users') && (
              <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC(c.to === 'roles' ? { roles: w.roles } : { users: w.users })} empty={c.to === 'roles' ? t('choose roles') : t('choose people')} />
            )}
            <Field label={t('Message')} hint={t('optional')}><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder={t('E.g. review by end of day')} /></Field>
          </>}
          {r.action === 'webhook' && <>
            <Field label={t('URL')}><input className="field-input font-mono text-xs" value={c.url ?? ''} onChange={(e) => setC({ url: e.target.value })} placeholder={t('https://hooks.slack.com/services/…')} /></Field>
            <Field label={t('Message')} hint={t('optional')}><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} /></Field>
          </>}
          {r.action === 'comment' && <Field label={t('Comment')}><textarea className="field-input" rows={3} value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder={t('E.g. before approving, go through the security checklist.')} /></Field>}
          {r.action === 'move' && <>
            <Field label={t('Move to')}>
              <select className="field-input" value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value })}>
                <option value="" disabled>{t('choose the stage')}</option>
                {(tt.stage ? others : stages).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            {tt.stage && <p className="text-xs text-mute">{t('Move ends the stage\'s sequence: keep this rule last.')}</p>}
          </>}
          {r.action === 'assign' && <>
            <Field label={t('Who becomes the assignee')}>
              <select className="field-input" value={c.mode ?? 'user'} onChange={(e) => setC({ mode: e.target.value, users: [], roles: [] })}>
                <option value="user">{t('A fixed person')}</option>
                <option value="creator">{t('Whoever created the issue')}</option>
                <option value="requester">{t('The requester')}</option>
                <option value="balance">{t('Spread: whoever has the fewest issues in the group')}</option>
              </select>
            </Field>
            {(c.mode ?? 'user') === 'user' && <WhoPicker value={{ users: c.users }} onChange={(w) => setC({ users: (w.users ?? []).slice(-1) })} empty={t('choose the person')} />}
            {c.mode === 'balance' && <WhoPicker value={{ roles: c.roles, users: c.users }} onChange={(w) => setC({ roles: w.roles, users: w.users })} empty={t('choose roles and/or people')} />}
          </>}
          {r.action === 'set_priority' && (
            <Field label={t('Priority')}>
              <select className="field-input" value={c.priority ?? 1} onChange={(e) => setC({ priority: Number(e.target.value) })}>
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
          )}
          {r.action === 'add_label' && (
            <Field label={t('Label')}>
              <select className="field-input" value={c.labelId ?? ''} onChange={(e) => setC({ labelId: e.target.value })}>
                <option value="" disabled>{t('choose')}</option>
                {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          {(r.action === 'run_agent' || r.action === 'set_agent') && (
            <div className="flex flex-wrap gap-1.5">
              {r.action === 'run_agent' && <button type="button" onClick={() => setC({ agentId: '' })} className={clsx('rounded-full border px-3 py-1 text-xs', !c.agentId ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>{t('The issue\'s')}</button>}
              {agents.map((a) => (
                <button key={a.id} type="button" onClick={() => setC({ agentId: a.id })} className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', c.agentId === a.id ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>
                  <AgentIcon avatar={a.avatar} size={14} /> {a.name}
                </button>
              ))}
            </div>
          )}
          {r.action === 'run_agent' && <>
            <Field label={t('What to ask')} hint={t('empty = run the issue')}><textarea className="field-input" rows={3} value={c.request ?? ''} onChange={(e) => setC({ request: e.target.value })} placeholder={t('E.g. review the diff and run the tests.')} /></Field>
            {(r.trigger === 'enter' || r.trigger === 'stale') && (
              <label className={clsx('flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition', c.wait ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-white/15')}>
                <Toggle checked={!!c.wait} onChange={(wait) => setC({ wait })} />
                <span>
                  <span className="block text-[13px] font-medium">{t('Wait for it to finish in this stage')}</span>
                  <span className="block text-xs text-mute">{t('On: the issue stays here while the agent works and the following rules run when it finishes (e.g. AI review). Off: a normal request, and the “Agent started” and “Agent run finished” rules decide the stage.')}</span>
                </span>
              </label>
            )}
            {c.wait && <>
              <Field label={t('If the AI needs someone, move to')} hint={t('optional')}>
                <select className="field-input" value={c.onWaiting ?? ''} onChange={(e) => setC({ onWaiting: e.target.value })}>
                  <option value="">{t('don\'t move (the sequence stops)')}</option>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              {onFail}
            </>}
            <p className="text-xs text-mute">{t('With no agent on the issue (and none chosen here), the rule does nothing: it stays a manual task.')}</p>
          </>}
          {r.action === 'stop_agent' && <p className="text-xs text-mute">{t('If the issue has a queued or running execution, it\'s cancelled; the “stopped” result fires the “Agent run finished” rules.')}</p>}
          {r.action === 'close' && (
            <div className="grid gap-2 sm:grid-cols-2">
              {([['done', t('Done'), t('Counts as resolved: goes into “issues resolved” and time to resolve.')], ['cancelled', t('Cancelled'), t('Leaves the open issues without counting as resolved.')]] as const).map(([k, label, desc]) => (
                <button key={k} type="button" onClick={() => setC({ kind: k })}
                  className={clsx('rounded-xl border p-3 text-left transition', (c.kind ?? 'done') === k ? 'border-accent/50 bg-accent/10' : 'border-line hover:border-white/15')}>
                  <span className="block text-[13px] font-medium">{label}</span>
                  <span className="block text-xs text-mute">{desc}</span>
                </button>
              ))}
            </div>
          )}
          {r.action === 'open_pr' && <>
            <Field label={t('PR target branch')} hint={t('empty = the issue\'s merge branch')}><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder={t('main')} /></Field>
            <Toggle checked={!!c.draft} onChange={(draft) => setC({ draft })} label={t('Open as draft')} />
            {onFail}
          </>}
          {r.action === 'merge' && <Field label={t('Branch')} hint={t('empty = each issue\'s target')}><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder={t('main')} /></Field>}
          {r.action === 'script' && <>
            <Field label={t('Script (bash)')}>
              <textarea className="field-input font-mono text-xs" rows={4} spellCheck={false} value={c.script ?? ''} onChange={(e) => setC({ script: e.target.value })}
                placeholder={t('curl -X POST https://ci.example.com/deploy -d "branch=$FOREMAN_BRANCH"')} />
            </Field>
            <p className="text-[11px] text-mute">{t('FOREMAN_ISSUE, _TITLE, _BRANCH, _STAGE, _FROM, _EVENT, _PRIORITY, _README, _WORKSPACE · up to 10 min.')}</p>
            {onFail}
          </>}
        </div>
      )}

      {step === 3 && !access && (
        <div className="space-y-4">
          <p className="text-xs text-mute">{t('The rule only fires if the issue matches every checked filter. With no filters, it applies to every issue.')}</p>
          {!tt.stage && <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('The issue is in the stage')}</span>
            <Chips options={stages.map((x) => [x.id, x.name] as [string, string])} value={cond.stages ?? []} onChange={(st) => setCond({ stages: st })} /></div>}
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Priority is')}</span>
            <Chips options={PRIORITIES.map((p) => [p.id, p.label] as [number, string])} value={cond.priorities ?? []} onChange={(priorities) => setCond({ priorities })} /></div>
          {labels.length > 0 && <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Has any of these labels')}</span>
            <Chips options={labels.map((l) => [l.id, l.name] as [string, string])} value={cond.labels ?? []} onChange={(l) => setCond({ labels: l })} /></div>}
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Issue agent is')}</span>
            <Chips options={agents.map((a) => [a.id, a.name] as [string, string])} value={cond.agents ?? []} onChange={(a) => setCond({ agents: a })} /></div>
          <div className="flex flex-col gap-1.5"><span className="text-xs font-medium text-dim">{t('Whoever caused it has the role')}</span>
            <Chips options={roles.map((x) => [x.id, x.name] as [string, string])} value={cond.actorRoles ?? []} onChange={(actorRoles) => setCond({ actorRoles })} /></div>
        </div>
      )}
    </Modal>
  );
}

// ---------- copy to another workspace ----------

function CopyModal({ onClose }: { onClose: () => void }) {
  const { ws } = useWs();
  const { data: workspaces = [] } = useWorkspaces();
  const qc = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<{ warnings: WorkflowWarning[]; stages: number; rules: number; replaced: { stages: number; rules: number }; movedIssues: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = workspaces.filter((w) => w.id !== ws.id);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const res = await api.post<{ warnings: WorkflowWarning[]; stages: number; rules: number; replaced: { stages: number; rules: number }; movedIssues: number }>(`/workspaces/${ws.id}/workflow/copy`, { to, dryRun });
      if (dryRun) setPreview(res);
      else {
        toast('success', t('Workflow copied: {0} stages and {1} rules', res.stages, res.rules));
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
    <Modal open onClose={onClose} title={t('Copy workflow to another workspace')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
        {preview ? <Button variant="primary" loading={busy} onClick={() => run(false)}>{t('Replace the destination\'s workflow')}</Button>
          : <Button variant="primary" loading={busy} disabled={!to} onClick={() => run(true)}>{t('See what changes')}</Button>}</>}>
      <div className="space-y-4">
        <Field label={t('Destination')}>
          <select className="field-input" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }}>
            <option value="" disabled>{t('choose the workspace')}</option>
            {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <p className="text-xs text-mute">{t('The destination\'s workflow is undone and becomes identical to {0}\'s: stages, rules and access rules, as they are. People without access to the destination go along and show up in that workflow\'s alerts for someone to fix (they don\'t gain access because of it). Labels are matched or created by name.', ws.name)}</p>
        {preview && (
          <div className="space-y-3">
            <div className="rounded-xl border border-red-400/25 bg-red-400/[0.06] p-3 text-xs text-red-200">
              <div className="mb-1 font-medium">{t('What will be deleted in the destination')}</div>
              <ul className="space-y-0.5 pl-4">
                <li className="list-disc">{t('{0} current stage(s) and {1} rule(s)', preview.replaced.stages, preview.replaced.rules)}</li>
                {preview.movedIssues > 0 && <li className="list-disc">{t('{0} issue(s) in stages that stop existing go to the first stage', preview.movedIssues)}</li>}
              </ul>
              <div className="mt-2 text-dim">{t('In their place: {0} stage(s) and {1} rule(s) from {2}.', preview.stages, preview.rules, ws.name)}</div>
            </div>
            {preview.warnings.length > 0 ? (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-200">
                <div className="mb-1 font-medium">{t('Will need fixing in the destination ({0})', preview.warnings.length)}</div>
                <ul className="space-y-0.5 pl-4">{preview.warnings.map((w, i) => <li key={i} className="list-disc"><b className="font-medium">{w.where}:</b> {w.message}</li>)}</ul>
              </div>
            ) : <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] p-3 text-xs text-emerald-200">{t('Nothing to fix afterwards: everyone mentioned has access to the destination.')}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
