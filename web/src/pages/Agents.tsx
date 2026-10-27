import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, Cpu, Gauge, Pencil, Plus, ShieldCheck, Trash2, Wallet } from 'lucide-react';
import { Button, EmptyState, Field, Modal, PageHeader, useToast } from '../components/ui';
import { api } from '../lib/api';
import { CLAUDE_MODELS, EFFORTS } from '../lib/constants';
import { useCan, useAgents, useSkills } from '../lib/queries';
import type { Agent } from '../lib/types';

const EMOJIS = ['🤖', '🦉', '🌙', '🦊', '🐙', '⚡', '🧪', '🛠️', '🎨', '🔍', '🚀', '🧠'];

export function AgentsPage() {
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const canCreate = useCan('agent.create');
  const canUpdate = useCan('agent.update');
  const canDelete = useCan('agent.delete');

  const remove = async (a: Agent) => {
    if (!confirm(`Remover ${a.name}? O histórico de execuções e custos continua.`)) return;
    await api.del(`/agents/${a.id}`);
    qc.invalidateQueries({ queryKey: ['agents'] });
    toast('success', 'Agente removido');
  };

  const create = () => setEditing({ runtime: 'claude', model: 'sonnet', permission: 'full', avatar: '🤖', skillIds: [] });
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-4 pb-24 md:p-8">
        <PageHeader
          icon={Bot}
          title="Agentes"
          description="Cada agente é um preset (runtime, modelo, instruções e um pacote de skills) e vale em todos os workspaces. Mesmo modelo, papéis diferentes: dev, revisor, testes. Toda execução começa num chat limpo."
          actions={canCreate && <Button variant="primary" onClick={create}><Plus className="size-4" /> Novo agente</Button>}
        />
        {agents.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((a) => {
              const pack = skills.filter((s) => s.always || a.skillIds.includes(s.id));
              return (
                <div key={a.id} className="surface surface-hover group flex flex-col p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-white/10 to-white/[0.02] text-xl">{a.avatar}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{a.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-mute">
                        <span className={a.runtime === 'claude' ? 'text-[#e58f5c]' : 'text-emerald-400'}>{a.runtime === 'claude' ? 'Claude Code' : 'Codex'}</span>
                        <span>·</span><span className="truncate">{a.model || 'modelo padrão'}</span>
                      </div>
                    </div>
                    <div className="flex gap-0.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                      {canCreate && <button title="Duplicar" onClick={() => setEditing({ ...a, id: undefined, name: `${a.name} (cópia)` })} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Copy className="size-4" /></button>}
                      {canUpdate && <button title="Editar" onClick={() => setEditing(a)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-4" /></button>}
                      {canDelete && <button title="Remover" onClick={() => remove(a)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-4" /></button>}
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 min-h-[2.5em] text-[13px] text-dim">{a.instructions || <span className="text-mute">Sem instruções próprias.</span>}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-dim">
                    {a.effort && <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5"><Gauge className="size-3" /> {a.effort}</span>}
                    {a.maxBudgetUsd ? <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5"><Wallet className="size-3" /> até ${a.maxBudgetUsd}</span> : null}
                    <span className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5"><ShieldCheck className="size-3" /> {a.permission === 'full' ? 'total' : 'só edições'}</span>
                  </div>
                  <div className="mt-3 border-t border-line/70 pt-3">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-mute"><Cpu className="size-3" /> {pack.length} skill(s) no pacote</div>
                    <div className="flex flex-wrap gap-1">
                      {pack.map((s) => <span key={s.id} className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[11px] text-fg/90">{s.name}</span>)}
                      {!pack.length && <span className="text-[11px] text-mute">Nenhuma skill indexada.</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Bot} title="Nenhum agente ainda" action={canCreate && <Button variant="primary" onClick={create}><Plus className="size-4" /> Criar o primeiro agente</Button>}>
            Ex.: "Dev Sonnet" com as skills de padrão de código e testes, e "Revisor" com o checklist de revisão.
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
      toast('success', 'Agente salvo');
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const skillIds = a.skillIds ?? [];
  return (
    <Modal open wide onClose={onClose} title={a.id ? `Editar ${agent.name}` : 'Novo agente'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="space-y-4">
        <div className="flex gap-3">
          <Field label="Ícone">
            <select value={a.avatar} onChange={(e) => set({ avatar: e.target.value })} className="field-input w-16 text-center text-lg">
              {EMOJIS.map((e) => <option key={e}>{e}</option>)}
            </select>
          </Field>
          <Field label="Nome" className="flex-1"><input autoFocus className="field-input" value={a.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="Claude Dev, Codex Revisor…" /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Runtime">
            <select className="field-input" value={a.runtime} onChange={(e) => set({ runtime: e.target.value as Agent['runtime'], effort: '', model: e.target.value === 'claude' ? 'sonnet' : '' })}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </Field>
          <Field label="Modelo" hint="vazio = padrão do CLI">
            <input className="field-input" list="models" value={a.model ?? ''} onChange={(e) => set({ model: e.target.value })} />
            <datalist id="models">{a.runtime === 'claude' && CLAUDE_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
          <Field label="Esforço">
            <select className="field-input" value={a.effort ?? ''} onChange={(e) => set({ effort: e.target.value })}>
              {EFFORTS[a.runtime ?? 'claude'].map((e) => <option key={e} value={e}>{e || 'padrão'}</option>)}
            </select>
          </Field>
          <Field label="Teto por execução (US$)" hint="só Claude">
            <input className="field-input" type="number" min="0" step="0.5" disabled={a.runtime !== 'claude'} value={a.maxBudgetUsd ?? ''} onChange={(e) => set({ maxBudgetUsd: e.target.value === '' ? null : Number(e.target.value) })} placeholder="sem teto" />
          </Field>
          <Field label="Permissões" className="sm:col-span-2">
            <select className="field-input" value={a.permission} onChange={(e) => set({ permission: e.target.value as Agent['permission'] })}>
              <option value="full">Total: roda comandos sem pedir (worktree isolado)</option>
              <option value="edits">Só edições de arquivo</option>
            </select>
          </Field>
        </div>
        <Field label="Instruções" hint="papel, estilo e regras; vão como system prompt">
          <textarea className="field-input" rows={6} value={a.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} placeholder="Você é um dev sênior. Mudanças pequenas e focadas, siga o estilo do código, rode os testes…" />
        </Field>
        <Field label="Skills do agente" hint={`${skillIds.length + skills.filter((x) => x.always && !skillIds.includes(x.id)).length} no pacote; vão em toda execução deste agente`}>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => {
              const on = s.always || skillIds.includes(s.id);
              return (
                <button key={s.id} type="button" disabled={s.always} title={s.description}
                  onClick={() => set({ skillIds: on ? skillIds.filter((x) => x !== s.id) : [...skillIds, s.id] })}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-dim hover:bg-hover'}`}>
                  {s.name}{s.always && ' · sempre'}
                </button>
              );
            })}
            {!skills.length && <span className="text-xs text-mute">Nenhuma skill criada ainda.</span>}
          </div>
        </Field>
        <Field label="Argumentos extras do CLI" hint="avançado">
          <input className="field-input font-mono text-xs" value={a.extraArgs ?? ''} onChange={(e) => set({ extraArgs: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
