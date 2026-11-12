import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Bot, Check, ChevronDown, Copy, Cpu, Gauge, Pencil, Plug, Plus, RefreshCw, Sparkles, Trash2, Wallet } from 'lucide-react';
import { Button, EmptyState, Field, Modal, PageHeader, Popover, useToast, useConfirm } from '../components/ui';
import { AGENT_COLORS, AGENT_ICONS, AgentIcon, parseAvatar } from '../components/AgentIcon';
import { api } from '../lib/api';
import { connectionOf, modelStatus, runtimeConnection, useCan, useAgents, useModels, useSkills, type Connection } from '../lib/queries';
import { ago, timeAgo } from '../lib/format';
import { RUNTIMES, runtimeOf } from '../lib/constants';
import type { Agent, Probe, RuntimeModels } from '../lib/types';
import { t } from '../lib/i18n';

export function AgentsPage() {
  const ask = useConfirm();
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const { data: catalog } = useModels();
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('agent.create');
  const canUpdate = useCan('agent.update');
  const canDelete = useCan('agent.delete');

  const remove = async (a: Agent) => {
    if (!(await ask({ title: t('Remove {0}?', a.name), message: t('Run and cost history is kept.'), danger: true }))) return;
    await api.del(`/agents/${a.id}`);
    qc.invalidateQueries({ queryKey: ['agents'] });
    toast('success', t('Agent removed'));
  };

  const create = () => setEditing({ runtime: 'claude', model: 'sonnet', avatar: 'bot:violet', skillIds: [] });
  const checking = !!catalog?.some((r) => r.checking);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  // Tests every runtime and model again, in the background (the cards update as it goes).
  const checkAll = async () => {
    try {
      qc.setQueryData(['models'], await api.post<RuntimeModels[]>('/runtimes/check'));
      toast('info', t('Testing the connection of every AI…'));
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  // Tests this agent's runtime and model right now.
  const checkOne = async (a: Agent) => {
    setTesting((x) => ({ ...x, [a.id]: true }));
    try {
      const p = await api.post<Probe>(`/agents/${a.id}/check`);
      await qc.invalidateQueries({ queryKey: ['models'] });
      if (p.ok) toast('success', t('{0} answered in {1}s', a.name, (p.ms / 1000).toFixed(1)));
      else toast('error', t('{0} didn\'t work: {1}', a.name, p.error ?? ''));
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setTesting((x) => ({ ...x, [a.id]: false }));
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="page">
        <PageHeader
          icon={Bot}
          title={t('Agents')}
          description={t('Each agent is a runtime and a model from the server, shared by every workspace. Role, style and rules go in Skills, linked to the agent. Every run starts in a clean chat.')}
          actions={<>
            {(canCreate || canUpdate) && <Button onClick={checkAll} loading={checking}><Plug className="size-4" /> {checking ? t('Testing…') : t('Test all')}</Button>}
            {canCreate && <Button variant="primary" onClick={create}><Plus className="size-4" /> {t('New agent')}</Button>}
          </>}
        />
        {agents.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((a) => {
              const pack = skills.filter((s) => s.always || a.skillIds.includes(s.id));
              const { option, warning } = modelStatus(catalog, a.runtime, a.model, a.effort);
              const conn = testing[a.id] ? { state: 'checking' as const } : connectionOf(catalog, a.runtime, a.model);
              return (
                <div key={a.id} className="surface flex flex-col p-4">
                  <div className="flex items-start gap-3">
                    <AgentIcon avatar={a.avatar} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{a.name}</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-mute">
                        <span className={clsx('shrink-0', runtimeOf(a.runtime).color)}>{runtimeOf(a.runtime).label}</span>
                        <span>·</span><span className="truncate">{option?.label ?? (a.model || t('default model'))}</span>
                      </div>
                    </div>
                    <div className="-mr-1.5 -mt-1 flex shrink-0 text-mute">
                      {canCreate && <button title={t('Duplicate')} onClick={() => setEditing({ ...a, id: undefined, name: t('{0} (copy)', a.name) })} className="icon-btn"><Copy className="size-4" /></button>}
                      {canUpdate && <button title={t('Edit')} onClick={() => setEditing(a)} className="icon-btn"><Pencil className="size-4" /></button>}
                      {canDelete && <button title={t('Remove')} onClick={() => remove(a)} className="icon-btn icon-btn-danger"><Trash2 className="size-4" /></button>}
                    </div>
                  </div>
                  <ConnectionRow conn={conn} onTest={() => checkOne(a)} onPick={canUpdate ? () => setEditing(a) : undefined} />
                  {warning && conn.state !== 'fail' && (
                    <div className="callout mt-3">
                      <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" />
                      <span>{warning}. {canUpdate && <button onClick={() => setEditing(a)} className="font-medium underline-offset-2 hover:underline">{t('Pick another')}</button>}</span>
                    </div>
                  )}
                  <div className="mb-3 mt-3 flex flex-wrap gap-1.5 empty:hidden">
                    {a.effort && <span className="badge"><Gauge className="size-3" /> {a.effort}</span>}
                    {a.maxBudgetUsd ? <span className="badge"><Wallet className="size-3" /> {t('up to $')}{a.maxBudgetUsd}</span> : null}
                  </div>
                  <div className="mt-auto border-t border-line pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-mute"><Cpu className="size-3" /> {pack.length} {t('skill(s) in the bundle')}</div>
                    <div className="flex flex-wrap gap-1">
                      {pack.map((s) => <span key={s.id} className="badge">{s.name}</span>)}
                      {!pack.length && <span className="text-[11px] text-mute">{t('No skills indexed.')}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Bot} title={t('No agents yet')} action={canCreate && <Button variant="primary" onClick={create}><Plus className="size-4" /> {t('Create the first agent')}</Button>}>
            {t('E.g. "Dev Sonnet" with the code-style and testing skills, and "Reviewer" with the review checklist.')}
          </EmptyState>
        )}
      </div>
      {editing && <AgentModal agent={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// The agent's connection, per the last real test: works, doesn't (and why), not tested yet.
function ConnectionRow({ conn, onTest, onPick }: { conn: Connection; onTest: () => void; onPick?: () => void }) {
  const tone = { ok: 'bg-emerald-400', fail: 'bg-red-400', busy: 'bg-amber-400', checking: 'bg-amber-400 animate-pulse-soft', untested: 'bg-mute' }[conn.state];
  const label = {
    ok: t('Connected · tested {0}', conn.at ? ago(conn.at) : ''),
    fail: t('Not working with this account'),
    busy: t('Model overloaded at the last test · try again later'),
    checking: t('Testing the connection…'),
    untested: t('Connection not tested yet')
  }[conn.state];
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 text-xs">
        <span className={clsx('size-1.5 shrink-0 rounded-full', tone)} />
        <span className={clsx('min-w-0 flex-1 truncate', conn.state === 'fail' ? 'text-red-400' : 'text-mute')}>{label}</span>
        <button onClick={onTest} disabled={conn.state === 'checking'} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-dim transition-colors hover:bg-hover hover:text-fg disabled:opacity-50">
          <Plug className="size-3" /> {t('Test')}
        </button>
      </div>
      {conn.state === 'fail' && conn.problem && (
        <p className="mt-1.5 rounded-md bg-red-500/[0.07] px-2.5 py-1.5 text-[11px] leading-snug text-red-300 [overflow-wrap:anywhere]">
          {conn.problem}
          {onPick && <> <button onClick={onPick} className="font-medium underline-offset-2 hover:underline">{t('Pick another')}</button></>}
        </p>
      )}
    </div>
  );
}

function AgentModal({ agent, onClose }: { agent: Partial<Agent>; onClose: () => void }) {
  const [a, setA] = useState<Partial<Agent>>(agent);
  const [busy, setBusy] = useState(false);
  const { data: skills = [] } = useSkills();
  const qc = useQueryClient();
  const toast = useToast();
  const set = (p: Partial<Agent>) => setA((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...a, maxBudgetUsd: a.maxBudgetUsd ? Number(a.maxBudgetUsd) : null };
      if (a.id) await api.put(`/agents/${a.id}`, body);
      else await api.post('/agents', body);
      qc.invalidateQueries({ queryKey: ['agents'] });
      toast('success', t('Agent saved'));
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const skillIds = a.skillIds ?? [];
  const { data: catalog } = useModels();
  const rt = catalog?.find((c) => c.runtime === (a.runtime ?? 'claude'));
  const { option } = modelStatus(catalog, a.runtime ?? 'claude', a.model ?? '', a.effort ?? '');
  const efforts = option?.efforts ?? rt?.efforts ?? ['low', 'medium', 'high'];
  return (
    <Modal open wide onClose={onClose} title={a.id ? t('Edit {0}', agent.name) : t('New agent')} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">{t('Icon')}</span>
            <IconPicker value={a.avatar} onChange={(avatar) => set({ avatar })} />
          </div>
          <Field label={t('Name')} className="flex-1"><input autoFocus className="field-input" value={a.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={t('Claude Dev, Codex Reviewer, Gemini Tester…')} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Runtime')}>
            <select className="field-input" value={a.runtime} onChange={(e) => set({ runtime: e.target.value as Agent['runtime'], effort: '', model: runtimeOf(e.target.value).defaultModel })}>
              {RUNTIMES.map((r) => {
                const c = runtimeConnection(catalog, r.id);
                return <option key={r.id} value={r.id}>{r.label}{c.state === 'fail' ? ` — ${t('no access')}` : ''}</option>;
              })}
            </select>
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">{t('Model')}</span>
            <ModelPicker catalog={catalog} runtime={a.runtime ?? 'claude'} value={a.model ?? ''} onChange={(model) => {
              const opt = catalog?.find((c) => c.runtime === a.runtime)?.models.find((m) => m.id === model);
              set({ model, effort: opt?.efforts && a.effort && !opt.efforts.includes(a.effort) ? '' : a.effort });
            }} />
          </div>
          <Field label={t('Effort')} hint={a.runtime === 'gemini' ? t('not available on Gemini') : option?.defaultEffort ? t('model default: {0}', option.defaultEffort) : undefined}>
            <select className="field-input" disabled={a.runtime === 'gemini'} value={a.effort ?? ''} onChange={(e) => set({ effort: e.target.value })}>
              <option value="">{t('default')}</option>
              {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
              {a.effort && !efforts.includes(a.effort) && <option value={a.effort}>{a.effort} {t('(not supported)')}</option>}
            </select>
          </Field>
          <Field label={t('Cap per run (US$)')} hint={t('Claude only')}>
            <input className="field-input" type="number" min="0" step="0.5" disabled={a.runtime !== 'claude'} value={a.maxBudgetUsd ?? ''} onChange={(e) => set({ maxBudgetUsd: e.target.value === '' ? null : Number(e.target.value) })} placeholder={t('no cap')} />
          </Field>
        </div>
        <Field label={t('Agent skills')} hint={t('{0} in the bundle; sent on every run of this agent', skillIds.length + skills.filter((x) => x.always && !skillIds.includes(x.id)).length)}>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => {
              const on = s.always || skillIds.includes(s.id);
              return (
                <button key={s.id} type="button" disabled={s.always} title={s.description}
                  onClick={() => set({ skillIds: on ? skillIds.filter((x) => x !== s.id) : [...skillIds, s.id] })}
                  aria-pressed={on} className={clsx('pill', s.always && 'cursor-default')}>
                  {on ? <Check className="size-3 text-accent" /> : <Plus className="size-3" />}
                  {s.name}{s.always && <span className="text-mute">{t('· always')}</span>}
                </button>
              );
            })}
            {!skills.length && <span className="text-xs text-mute">{t('No skills created yet.')}</span>}
          </div>
        </Field>
        <details className="group" open={!!a.extraArgs}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-mute hover:text-dim">
            <ChevronDown className="size-3.5 -rotate-90 transition group-open:rotate-0" /> {t('Advanced')}
          </summary>
          <Field label={t('Extra CLI arguments')} className="mt-3">
            <input className="field-input font-mono text-xs" value={a.extraArgs ?? ''} onChange={(e) => set({ extraArgs: e.target.value })} />
          </Field>
        </details>
      </div>
    </Modal>
  );
}

// The agent's icon picker: an icon grid + colors.
function IconPicker({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const { icon, color } = parseAvatar(value);
  return (
    <Popover
      className="w-[272px] p-3"
      trigger={(open) => (
        <button type="button" className={clsx('flex h-[38px] items-center gap-1.5 rounded-lg border pl-1.5 pr-2 transition-colors', open ? 'border-accent' : 'border-line hover:border-white/20')}>
          <AgentIcon avatar={`${icon}:${color}`} size={26} />
          <ChevronDown className="size-3.5 text-mute" />
        </button>
      )}
    >
      {() => (
        <div>
          <div className="mb-2 text-[11px] font-medium text-mute">{t('Icon')}</div>
          <div className="grid grid-cols-7 gap-1">
            {Object.entries(AGENT_ICONS).map(([k, I]) => (
              <button key={k} type="button" title={k} onClick={() => onChange(`${k}:${color}`)}
                className={clsx('grid size-8 place-items-center rounded-lg transition', k === icon ? 'bg-accent/20 text-fg ring-1 ring-accent/60' : 'text-dim hover:bg-hover hover:text-fg')}>
                <I className="size-4" />
              </button>
            ))}
          </div>
          <div className="mb-2 mt-3 text-[11px] font-medium text-mute">{t('Color')}</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(AGENT_COLORS).map(([k, [from, to]]) => (
              <button key={k} type="button" title={k} onClick={() => onChange(`${icon}:${k}`)}
                className={clsx('size-6 rounded-full transition hover:scale-110', k === color && 'ring-2 ring-white/80 ring-offset-2 ring-offset-panel')}
                style={{ background: `linear-gradient(145deg, ${from}, ${to})` }} />
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

// Model selection from the CLIs' catalog; "Other" accepts a name typed by hand.
function ModelPicker({ catalog, runtime, value, onChange }: { catalog?: RuntimeModels[]; runtime: string; value: string; onChange: (v: string) => void }) {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [custom, setCustom] = useState(false);
  const rt = catalog?.find((c) => c.runtime === runtime);
  const models = rt?.models ?? [];
  const current = models.find((m) => m.id === value);
  const known = (!value || !!current) && current?.available !== false && rt?.connected !== false;
  // Like /model in each CLI: only what this server's account can use (it answered the
  // test, or was only overloaded at the time). Nothing else is listed.
  // Reads the CLIs' catalog again and tests every model again.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.get<RuntimeModels[]>('/runtimes/models?refresh=1');
      qc.setQueryData(['models'], await api.post<RuntimeModels[]>('/runtimes/check'));
    } finally {
      setRefreshing(false);
    }
  };
  const groups: [string, string][] = runtime === 'claude'
    ? [['alias', t('Claude models')]]
    : runtime === 'gemini'
      ? [['alias', t('Automatic')], ['model', t('Gemini models')]]
      : [['model', t('Codex models')]];

  if (custom) {
    return (
      <div className="flex gap-2">
        <input autoFocus className="field-input font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('exact model name')} />
        <Button type="button" variant="ghost" onClick={() => setCustom(false)}>{t('List')}</Button>
      </div>
    );
  }
  return (
    <Popover
      block
      align="right"
      className="w-[min(380px,calc(100vw-2rem))] p-1.5"
      trigger={(open) => (
        <button type="button" className={clsx('field-input flex h-[38px] items-center gap-2 text-left', open && 'border-accent')}>
          {known ? <Cpu className="size-4 shrink-0 text-mute" /> : <AlertTriangle className={clsx('size-4 shrink-0', current?.available === false || rt?.connected === false ? 'text-red-400' : 'text-amber-400')} />}
          <span className="min-w-0 flex-1 truncate">
            {current ? current.label : value ? <span className="font-mono text-xs">{value}</span> : t('CLI default')}
            {current?.group === 'alias' && <span className="ml-1.5 text-xs text-mute">{t('latest')}</span>}
          </span>
          <ChevronDown className="size-4 shrink-0 text-mute" />
        </button>
      )}
    >
      {(close) => (
        <div>
          {rt?.defaultOk !== false && <ModelRow selected={!value} title={t('CLI default')} desc={t('Whatever is configured in the server\'s CLI')} onClick={() => { onChange(''); close(); }} />}
          {!rt?.installed && <div className="px-2.5 py-2 text-xs text-amber-300">{rt?.error ?? t('Loading catalog…')}</div>}
          {rt?.installed && rt.connected === false && (
            <div className="m-1 rounded-lg bg-red-500/[0.08] px-2.5 py-2 text-xs leading-snug text-red-300 [overflow-wrap:anywhere]">
              <div className="font-medium">{t('{0} isn\'t working with this server\'s account', runtimeOf(runtime).label)}</div>
              {rt.checkError && <div className="mt-0.5 opacity-90">{rt.checkError}</div>}
            </div>
          )}
          {rt?.checking && <div className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-mute"><RefreshCw className="size-3 animate-spin" /> {t('Checking which models your plan has…')}</div>}
          {!rt?.checking && rt?.connected !== false && !models.some((m) => m.available === true || m.busy) && rt?.installed && (
            <div className="px-2.5 py-2 text-xs text-mute">{t('No model tested yet: use “Refresh and test”.')}</div>
          )}
          {rt?.connected !== false && groups.map(([g, title]) => {
            const list = models.filter((m) => m.group === g && (m.available === true || m.busy));
            if (!list.length) return null;
            return (
              <div key={g} className="mt-1 border-t border-line pt-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-mute">{g === 'alias' && <Sparkles className="size-3 text-accent" />}{title}</div>
                {list.map((m) => (
                  <ModelRow key={m.id} selected={m.id === value} title={m.label} id={m.id !== m.label ? m.id : undefined}
                    desc={m.description} onClick={() => { onChange(m.id); close(); }} />
                ))}
              </div>
            );
          })}
          <div className="mt-1 flex items-center gap-2 border-t border-line px-2.5 pb-1 pt-2 text-[11px] text-mute">
            <span className="min-w-0 flex-1 truncate" title={rt?.source}>{rt ? t('Read from {0} · {1}', rt.source, timeAgo(rt.fetchedAt)) : ''}</span>
            <button type="button" onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-dim transition hover:bg-hover hover:text-fg">
              <RefreshCw className={clsx('size-3', refreshing && 'animate-spin')} /> {t('Refresh and test')}
            </button>
            <button type="button" onClick={() => { setCustom(true); close(); }} className="rounded-md px-1.5 py-1 text-dim transition hover:bg-hover hover:text-fg">{t('Other…')}</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function ModelRow({ title, id, desc, selected, disabled, warn, onClick }: { title: string; id?: string; desc?: string; selected: boolean; disabled?: boolean; warn?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={clsx('flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50', selected ? 'bg-accent/[0.12]' : 'enabled:hover:bg-hover')}>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2"><span className="font-medium">{title}</span>{id && <span className="truncate font-mono text-[11px] text-mute">{id}</span>}</span>
        {desc && <span className={clsx('mt-0.5 block text-xs leading-snug', warn ? 'text-amber-400' : 'text-mute')}>{desc}</span>}
      </span>
      {selected && <Check className="mt-0.5 size-4 shrink-0 text-accent" />}
    </button>
  );
}
