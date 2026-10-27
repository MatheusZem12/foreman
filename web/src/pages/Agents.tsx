import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { Avatar, Button, Empty, Field, Modal, useToast } from '../components/ui';
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <div className="mb-1 flex items-center gap-2">
          <h1 className="text-lg font-semibold">Agentes</h1>
          {canCreate && <Button variant="primary" size="sm" className="ml-auto" onClick={() => setEditing({ runtime: 'claude', model: 'sonnet', permission: 'full', avatar: '🤖', skillIds: [] })}>
            <Plus className="size-3.5" /> Novo agente
          </Button>}
        </div>
        <p className="mb-5 text-dim">
          Valem para todos os workspaces. Cada agente é um preset: runtime, modelo, instruções e o pacote de skills indexadas.
          Dá para ter vários agentes com o mesmo modelo e papéis diferentes (dev, revisor, testes…). Em cada issue você escolhe o agente, e ele sempre começa num chat limpo.
        </p>
        <div className="space-y-2">
          {agents.map((a) => (
            <div key={a.id} className="flex items-start gap-3 rounded-lg border border-line bg-panel p-3">
              <Avatar emoji={a.avatar} size={32} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.name}</div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{a.runtime === 'claude' ? 'Claude Code' : 'Codex'}{a.model && ` · ${a.model}`}</span>
                  {a.effort && <span className="rounded bg-hover px-1.5 py-0.5 text-dim">esforço {a.effort}</span>}
                  {a.maxBudgetUsd ? <span className="rounded bg-hover px-1.5 py-0.5 text-dim">teto ${a.maxBudgetUsd}</span> : null}
                  <span className="rounded bg-hover px-1.5 py-0.5 text-dim">{a.permission === 'full' ? 'permissão total' : 'só edições'}</span>
                  {a.skillIds.map((id) => <span key={id} className="rounded bg-hover px-1.5 py-0.5 text-dim">{skills.find((s) => s.id === id)?.name}</span>)}
                </div>
                {a.instructions && <p className="mt-1.5 line-clamp-2 text-xs text-mute">{a.instructions}</p>}
              </div>
              <div className="flex gap-0.5">
                {canCreate && <button title="Duplicar" onClick={() => setEditing({ ...a, id: undefined, name: `${a.name} (cópia)` })} className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><Copy className="size-4" /></button>}
                {canUpdate && <button title="Editar" onClick={() => setEditing(a)} className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><Pencil className="size-4" /></button>}
                {canDelete && <button title="Remover" onClick={() => remove(a)} className="rounded p-1.5 text-mute hover:bg-hover hover:text-red-400"><Trash2 className="size-4" /></button>}
              </div>
            </div>
          ))}
          {!agents.length && <Empty>Nenhum agente. Crie um para começar a atribuir issues.</Empty>}
        </div>
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
