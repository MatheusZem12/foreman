import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Button, Field } from '../components/ui';
import type { Workspace } from '../lib/types';
import { t } from '../lib/i18n';

export function suggestKey(name: string) {
  const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return (words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 4)).slice(0, 6);
}

// A new workspace: just name and key. Repositories are added later under Workspace.
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
      // In the list before navigating: otherwise the address of the new workspace isn't
      // known yet and the screen falls back to the last one.
      qc.setQueryData<Workspace[]>(['workspaces'], (old) => [...(old ?? []).filter((w) => w.id !== ws.id), ws]);
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
      <Field label={t('Name')}><input autoFocus required className="field-input" value={name} onChange={(e) => { setName(e.target.value); if (!touched) setKey(suggestKey(e.target.value)); }} placeholder={t('Linguas')} /></Field>
      <Field label={t('Key')} hint={t('issue prefix, e.g. LING-12')}>
        <input required className="field-input font-mono uppercase" value={key} maxLength={10} onChange={(e) => { setTouched(true); setKey(e.target.value.toUpperCase()); }} />
      </Field>
      {error && <p role="alert" className="text-red-400">{error}</p>}
      <Button variant="primary" type="submit" loading={busy} className="w-full">{t('Create workspace')}</Button>
    </form>
  );
}

export function Onboarding() {
  const nav = useNavigate();
  return (
    <div className="grid h-full place-items-center overflow-y-auto px-4 py-14">
      <div className="w-full max-w-[22rem]">
        <img src="/icon.svg" className="size-10" alt="" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{t('New workspace')}</h1>
        <p className="mb-5 mt-1 text-dim">{t('A workspace groups a product\'s issues and its repositories.')}</p>
        <CreateWorkspaceForm onDone={(ws) => nav(`/w/${ws.key}/workspace`)} />
      </div>
    </div>
  );
}
