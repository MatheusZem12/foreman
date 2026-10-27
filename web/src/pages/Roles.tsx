import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Field, PageHeader, useToast } from '../components/ui';
import { Page } from './Account';
import { api } from '../lib/api';
import { usePermissions, useRoles } from '../lib/queries';
import type { Role } from '../lib/types';

// Perfis de acesso: só o dono vê esta tela. Cada perfil é um conjunto de
// permissões; cada usuário recebe um perfil em Usuários.
export function RolesPage() {
  const { data: roles = [] } = useRoles();
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  useEffect(() => {
    if (selected === null && roles.length) setSelected(roles[0].id);
  }, [roles, selected]);
  const current = selected === 'new' ? null : roles.find((r) => r.id === selected) ?? null;
  return (
    <Page>
      <PageHeader icon={ShieldCheck} title="Permissões" description="Só você, dono do Multica, vê esta tela. Monte perfis com o que cada grupo pode fazer e atribua em Usuários. O dono sempre pode tudo."
        actions={<Button variant="primary" onClick={() => setSelected('new')}><Plus className="size-4" /> Novo perfil</Button>} />
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {roles.map((r) => (
          <button key={r.id} onClick={() => setSelected(r.id)}
            className={clsx('shrink-0 rounded-full border px-3 py-1 text-xs', selected === r.id ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-dim hover:bg-hover')}>
            {r.name} <span className="text-mute">· {r.users}</span>
          </button>
        ))}
        {selected === 'new' && <span className="shrink-0 rounded-full border border-accent/60 bg-accent/15 px-3 py-1 text-xs">Novo perfil</span>}
      </div>
      {selected && <RoleEditor key={selected} role={current} onDone={setSelected} />}
    </Page>
  );
}

function RoleEditor({ role, onDone }: { role: Role | null; onDone: (id: string | null) => void }) {
  const { data: perms = [] } = usePermissions();
  const [name, setName] = useState(role?.name ?? '');
  const [on, setOn] = useState<string[]>(role?.permissions ?? ['issue.create', 'issue.update']);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const groups = [...new Set(perms.map((p) => p.group))];
  const toggle = (id: string) => setOn(on.includes(id) ? on.filter((x) => x !== id) : [...on, id]);
  const toggleGroup = (g: string) => {
    const ids = perms.filter((p) => p.group === g).map((p) => p.id);
    const all = ids.every((id) => on.includes(id));
    setOn(all ? on.filter((x) => !ids.includes(x)) : [...new Set([...on, ...ids])]);
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = { name, permissions: on };
      const saved = role ? await api.put<Role>(`/roles/${role.id}`, body) : await api.post<Role>('/roles', body);
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      toast('success', 'Perfil salvo; vale na hora para quem usa');
      onDone(saved.id);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!role || !confirm(`Excluir o perfil ${role.name}?`)) return;
    try {
      await api.del(`/roles/${role.id}`);
      qc.invalidateQueries({ queryKey: ['roles'] });
      onDone(null);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <Field label="Nome do perfil"><input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Dev, Revisor, Gestor" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((g) => {
          const items = perms.filter((p) => p.group === g);
          const all = items.every((p) => on.includes(p.id));
          return (
            <div key={g} className="surface p-3">
              <div className="mb-2 flex items-center">
                <span className="font-medium">{g}</span>
                <button onClick={() => toggleGroup(g)} className="ml-auto text-[11px] text-mute hover:text-fg">{all ? 'nenhuma' : 'todas'}</button>
              </div>
              <div className="space-y-1">
                {items.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-hover">
                    <input type="checkbox" checked={on.includes(p.id)} onChange={() => toggle(p.id)} className="mt-0.5 accent-[rgb(var(--accent))]" />
                    <span className="text-[13px] text-dim">{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        {role && <Button variant="ghost" onClick={remove}><Trash2 className="size-3.5" /> Excluir perfil</Button>}
        <span className="ml-auto text-xs text-mute">{on.length} de {perms.length} permissões</span>
        <Button variant="primary" loading={busy} onClick={save}>Salvar</Button>
      </div>
    </div>
  );
}
