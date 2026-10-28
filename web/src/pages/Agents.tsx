import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, Bot, Check, ChevronDown, Copy, Cpu, Gauge, Pencil, Plus, RefreshCw, Sparkles, Trash2, Wallet } from 'lucide-react';
import { Button, EmptyState, Field, Modal, PageHeader, Popover, useToast } from '../components/ui';
import { AGENT_COLORS, AGENT_ICONS, AgentIcon, parseAvatar } from '../components/AgentIcon';
import { api } from '../lib/api';
import { modelStatus, useCan, useAgents, useModels, useSkills } from '../lib/queries';
import { timeAgo } from '../lib/format';
import type { Agent, RuntimeModels } from '../lib/types';
import { t } from '../lib/i18n';

export function AgentsPage() {
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
    if (!confirm(t('Remover {0}? O histórico de execuções e custos continua.', a.name))) return;
    await api.del(`/agents/${a.id}`);
    qc.invalidateQueries({ queryKey: ['agents'] });
    toast('success', t('Agente removido'));
  };

  const create = () => setEditing({ runtime: 'claude', model: 'sonnet', avatar: 'bot:violet', skillIds: [] });
  return (
    <div className="h-full overflow-y-auto">
      <div className="page">
        <PageHeader
          icon={Bot}
          title={t('Agentes')}
          description={t('Cada agente é um preset (runtime, modelo, instruções e um pacote de skills) e vale em todos os workspaces. Mesmo modelo, papéis diferentes: dev, revisor, testes. Toda execução começa num chat limpo.')}
          actions={canCreate && <Button variant="primary" onClick={create}><Plus className="size-4" /> {t('Novo agente')}</Button>}
        />
        {agents.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((a) => {
              const pack = skills.filter((s) => s.always || a.skillIds.includes(s.id));
              const { option, warning } = modelStatus(catalog, a.runtime, a.model, a.effort);
              return (
                <div key={a.id} className="surface surface-hover group relative flex flex-col p-4">
                  <div className="flex items-start gap-3">
                    <AgentIcon avatar={a.avatar} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{a.name}</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-mute">
                        <span className={clsx('shrink-0', a.runtime === 'claude' ? 'text-[#e58f5c]' : 'text-emerald-400')}>{a.runtime === 'claude' ? t('Claude Code') : t('Codex')}</span>
                        <span>·</span><span className="truncate">{option?.label ?? (a.model || t('modelo padrão'))}</span>
                      </div>
                    </div>
                    <div className="absolute right-3 top-3 flex gap-0.5 rounded-lg bg-panel/90 p-0.5 opacity-100 backdrop-blur transition sm:opacity-0 sm:group-hover:opacity-100">
                      {canCreate && <button title={t('Duplicar')} onClick={() => setEditing({ ...a, id: undefined, name: t('{0} (cópia)', a.name) })} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Copy className="size-4" /></button>}
                      {canUpdate && <button title={t('Editar')} onClick={() => setEditing(a)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-4" /></button>}
                      {canDelete && <button title={t('Remover')} onClick={() => remove(a)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-4" /></button>}
                    </div>
                  </div>
                  {warning && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-2.5 py-2 text-xs text-amber-200">
                      <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" />
                      <span>{warning}. {canUpdate && <button onClick={() => setEditing(a)} className="font-medium underline-offset-2 hover:underline">{t('Escolher outro')}</button>}</span>
                    </div>
                  )}
                  <p className="mt-3 line-clamp-2 min-h-[2.5em] text-[13px] text-dim">{a.instructions || <span className="text-mute">{t('Sem instruções próprias.')}</span>}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-dim">
                    {a.effort && <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5"><Gauge className="size-3" /> {a.effort}</span>}
                    {a.maxBudgetUsd ? <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5"><Wallet className="size-3" /> {t('até $')}{a.maxBudgetUsd}</span> : null}
                  </div>
                  <div className="mt-3 border-t border-line/70 pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-mute"><Cpu className="size-3" /> {pack.length} {t('skill(s) no pacote')}</div>
                    <div className="flex flex-wrap gap-1">
                      {pack.map((s) => <span key={s.id} className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[11px] text-fg/90">{s.name}</span>)}
                      {!pack.length && <span className="text-[11px] text-mute">{t('Nenhuma skill indexada.')}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Bot} title={t('Nenhum agente ainda')} action={canCreate && <Button variant="primary" onClick={create}><Plus className="size-4" /> {t('Criar o primeiro agente')}</Button>}>
            {t('Ex.: "Dev Sonnet" com as skills de padrão de código e testes, e "Revisor" com o checklist de revisão.')}
          </EmptyState>
        )}
      </div>
      {editing && <AgentModal agent={editing} onClose={() => setEditing(null)} />}
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
      toast('success', t('Agente salvo'));
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
    <Modal open wide onClose={onClose} title={a.id ? t('Editar {0}', agent.name) : t('Novo agente')} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancelar')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('Salvar')}</Button></>}>
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">{t('Ícone')}</span>
            <IconPicker value={a.avatar} onChange={(avatar) => set({ avatar })} />
          </div>
          <Field label={t('Nome')} className="flex-1"><input autoFocus className="field-input" value={a.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={t('Claude Dev, Codex Revisor…')} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Runtime')}>
            <select className="field-input" value={a.runtime} onChange={(e) => set({ runtime: e.target.value as Agent['runtime'], effort: '', model: e.target.value === 'claude' ? 'sonnet' : '' })}>
              <option value="claude">{t('Claude Code')}</option>
              <option value="codex">{t('Codex')}</option>
            </select>
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-dim">{t('Modelo')}</span>
            <ModelPicker catalog={catalog} runtime={a.runtime ?? 'claude'} value={a.model ?? ''} onChange={(model) => {
              const opt = catalog?.find((c) => c.runtime === a.runtime)?.models.find((m) => m.id === model);
              set({ model, effort: opt?.efforts && a.effort && !opt.efforts.includes(a.effort) ? '' : a.effort });
            }} />
          </div>
          <Field label={t('Esforço')} hint={option?.defaultEffort ? t('padrão do modelo: {0}', option.defaultEffort) : undefined}>
            <select className="field-input" value={a.effort ?? ''} onChange={(e) => set({ effort: e.target.value })}>
              <option value="">{t('padrão')}</option>
              {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
              {a.effort && !efforts.includes(a.effort) && <option value={a.effort}>{a.effort} {t('(não suportado)')}</option>}
            </select>
          </Field>
          <Field label={t('Teto por execução (US$)')} hint={t('só Claude')}>
            <input className="field-input" type="number" min="0" step="0.5" disabled={a.runtime !== 'claude'} value={a.maxBudgetUsd ?? ''} onChange={(e) => set({ maxBudgetUsd: e.target.value === '' ? null : Number(e.target.value) })} placeholder={t('sem teto')} />
          </Field>
        </div>
        <Field label={t('Instruções')} hint={t('papel, estilo e regras; vão como system prompt')}>
          <textarea className="field-input" rows={6} value={a.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} placeholder={t('Você é um dev sênior. Mudanças pequenas e focadas, siga o estilo do código, rode os testes…')} />
        </Field>
        <Field label={t('Skills do agente')} hint={t('{0} no pacote; vão em toda execução deste agente', skillIds.length + skills.filter((x) => x.always && !skillIds.includes(x.id)).length)}>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => {
              const on = s.always || skillIds.includes(s.id);
              return (
                <button key={s.id} type="button" disabled={s.always} title={s.description}
                  onClick={() => set({ skillIds: on ? skillIds.filter((x) => x !== s.id) : [...skillIds, s.id] })}
                  className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition', on ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-dim hover:border-white/15 hover:bg-hover hover:text-fg', s.always && 'cursor-default')}>
                  {on ? <Check className="size-3 text-accent" /> : <Plus className="size-3" />}
                  {s.name}{s.always && <span className="text-mute">{t('· sempre')}</span>}
                </button>
              );
            })}
            {!skills.length && <span className="text-xs text-mute">{t('Nenhuma skill criada ainda.')}</span>}
          </div>
        </Field>
        <details className="group" open={!!a.extraArgs}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-mute hover:text-dim">
            <ChevronDown className="size-3.5 -rotate-90 transition group-open:rotate-0" /> {t('Avançado')}
          </summary>
          <Field label={t('Argumentos extras do CLI')} className="mt-3">
            <input className="field-input font-mono text-xs" value={a.extraArgs ?? ''} onChange={(e) => set({ extraArgs: e.target.value })} />
          </Field>
        </details>
      </div>
    </Modal>
  );
}

// Escolha do ícone do agente: grade de ícones + cores.
function IconPicker({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const { icon, color } = parseAvatar(value);
  return (
    <Popover
      className="w-[272px] p-3"
      trigger={(open) => (
        <button type="button" className={clsx('flex h-[38px] items-center gap-1.5 rounded-lg border bg-white/[0.02] pl-1.5 pr-2 transition', open ? 'border-accent/70 shadow-[0_0_0_3px_rgb(var(--accent)/0.15)]' : 'border-line hover:border-white/15')}>
          <AgentIcon avatar={`${icon}:${color}`} size={26} />
          <ChevronDown className="size-3.5 text-mute" />
        </button>
      )}
    >
      {() => (
        <div>
          <div className="mb-2 text-[11px] font-medium text-mute">{t('Ícone')}</div>
          <div className="grid grid-cols-7 gap-1">
            {Object.entries(AGENT_ICONS).map(([k, I]) => (
              <button key={k} type="button" title={k} onClick={() => onChange(`${k}:${color}`)}
                className={clsx('grid size-8 place-items-center rounded-lg transition', k === icon ? 'bg-accent/20 text-fg ring-1 ring-accent/60' : 'text-dim hover:bg-white/[0.07] hover:text-fg')}>
                <I className="size-4" />
              </button>
            ))}
          </div>
          <div className="mb-2 mt-3 text-[11px] font-medium text-mute">{t('Cor')}</div>
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

// Seleção de modelo a partir do catálogo dos CLIs; "Outro" aceita um nome à mão.
function ModelPicker({ catalog, runtime, value, onChange }: { catalog?: RuntimeModels[]; runtime: string; value: string; onChange: (v: string) => void }) {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [custom, setCustom] = useState(false);
  const rt = catalog?.find((c) => c.runtime === runtime);
  const models = rt?.models ?? [];
  const current = models.find((m) => m.id === value);
  const known = !value || !!current;
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(['models'], await api.get<RuntimeModels[]>('/runtimes/models?refresh=1'));
    } finally {
      setRefreshing(false);
    }
  };
  const groups: [string, string][] = runtime === 'claude'
    ? [['alias', t('Sempre a versão mais nova')], ['model', t('Versões fixas')], ['used', t('Versões fixas já usadas aqui')]]
    : [['model', t('Modelos do Codex')]];

  if (custom) {
    return (
      <div className="flex gap-2">
        <input autoFocus className="field-input font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('nome exato do modelo')} />
        <Button type="button" variant="ghost" onClick={() => setCustom(false)}>{t('Lista')}</Button>
      </div>
    );
  }
  return (
    <Popover
      block
      align="right"
      className="w-[min(380px,calc(100vw-2rem))] p-1.5"
      trigger={(open) => (
        <button type="button" className={clsx('field-input flex h-[38px] items-center gap-2 text-left', open && 'border-accent/70 shadow-[0_0_0_3px_rgb(var(--accent)/0.15)]')}>
          {known ? <Cpu className="size-4 shrink-0 text-mute" /> : <AlertTriangle className="size-4 shrink-0 text-amber-400" />}
          <span className="min-w-0 flex-1 truncate">
            {current ? current.label : value ? <span className="font-mono text-xs">{value}</span> : t('Padrão do CLI')}
            {current?.group === 'alias' && <span className="ml-1.5 text-xs text-mute">{t('mais recente')}</span>}
          </span>
          <ChevronDown className="size-4 shrink-0 text-mute" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <ModelRow selected={!value} title={t('Padrão do CLI')} desc={t('O que estiver configurado no claude/codex do servidor')} onClick={() => { onChange(''); close(); }} />
          {!rt?.installed && <div className="px-2.5 py-2 text-xs text-amber-300">{rt?.error ?? t('Carregando catálogo…')}</div>}
          {groups.map(([g, title]) => {
            const list = models.filter((m) => m.group === g);
            if (!list.length) return null;
            return (
              <div key={g} className="mt-1 border-t border-white/[0.06] pt-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-mute">{g === 'alias' && <Sparkles className="size-3 text-accent" />}{title}</div>
                {list.map((m) => (
                  <ModelRow key={m.id} selected={m.id === value} title={m.label} id={m.id !== m.label ? m.id : undefined} desc={m.description} onClick={() => { onChange(m.id); close(); }} />
                ))}
              </div>
            );
          })}
          <div className="mt-1 flex items-center gap-2 border-t border-white/[0.06] px-2.5 pb-1 pt-2 text-[11px] text-mute">
            <span className="min-w-0 flex-1 truncate" title={rt?.source}>{rt ? t('Lido do {0} · {1}', rt.source, timeAgo(rt.fetchedAt)) : ''}</span>
            <button type="button" onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-dim transition hover:bg-white/[0.06] hover:text-fg">
              <RefreshCw className={clsx('size-3', refreshing && 'animate-spin')} /> {t('Atualizar')}
            </button>
            <button type="button" onClick={() => { setCustom(true); close(); }} className="rounded-md px-1.5 py-1 text-dim transition hover:bg-white/[0.06] hover:text-fg">{t('Outro…')}</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function ModelRow({ title, id, desc, selected, onClick }: { title: string; id?: string; desc?: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={clsx('flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors', selected ? 'bg-accent/[0.12]' : 'hover:bg-white/[0.05]')}>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2"><span className="font-medium">{title}</span>{id && <span className="truncate font-mono text-[11px] text-mute">{id}</span>}</span>
        {desc && <span className="mt-0.5 block text-xs leading-snug text-mute">{desc}</span>}
      </span>
      {selected && <Check className="mt-0.5 size-4 shrink-0 text-accent" />}
    </button>
  );
}
