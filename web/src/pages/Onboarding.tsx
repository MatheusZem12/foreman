import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Button, Field } from '../components/ui';
import type { Workspace } from '../lib/types';

export function suggestKey(name: string) {
  const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 4)).slice(0, 6);
}

// Workspace novo: só nome e chave. Repositórios se adicionam depois em Workspace.
export function CreateWorkspaceForm({ onDone }: { onDone: (ws: Workspace) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const ws = await api.post<Workspace>('/workspaces', { name, key: key || suggestKey(name) });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      onDone(ws);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Nome"><input autoFocus required className="field-input" value={name} onChange={(e) => { setName(e.target.value); if (!touched) setKey(suggestKey(e.target.value)); }} placeholder="Linguas" /></Field>
      <Field label="Chave" hint="prefixo das issues, ex.: LING-12">
        <input required className="field-input font-mono uppercase" value={key} maxLength={10} onChange={(e) => { setTouched(true); setKey(e.target.value.toUpperCase()); }} />
      </Field>
      {error && <p className="text-red-400">{error}</p>}
      <Button variant="primary" type="submit" loading={busy} className="w-full">Criar workspace</Button>
    </form>
  );
}

export function Onboarding() {
  const nav = useNavigate();
  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">Novo workspace</h1>
        <p className="mb-4 mt-1 text-dim">Um workspace agrupa as issues de um produto e os repositórios dele.</p>
        <CreateWorkspaceForm onDone={(ws) => nav(`/w/${ws.key}/workspace`)} />
      </div>
    </div>
  );
}
