import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Button, Field, Spinner } from '../components/ui';
import type { User } from '../lib/types';
import { t } from '../lib/i18n';
import { PrefsQuick } from '../components/Prefs';

// The first access creates the administrator; after that it is a normal sign-in.
export function Login() {
  const { data, isLoading } = useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup') });
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const setup = data?.needsSetup;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = await api.post<User>(setup ? '/setup' : '/login', form);
      qc.setQueryData(['me'], u);
      nav('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  return (
    <div className="relative grid min-h-full place-items-center p-4">
      <PrefsQuick className="absolute right-3 top-3" />
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold"><img src="/icon.svg" className="size-6" alt="" /> {t('Foreman')}</div>
          <p className="mt-1 text-dim">{setup ? t('First access: create the administrator account.') : t('Sign in to continue.')}</p>
        </div>
        {setup && (
          <Field label={t('Name')}><input className="field-input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        )}
        <Field label={t('Email')}><input className="field-input" type="email" required autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label={t('Password')} hint={setup ? t('at least 8 characters') : undefined}>
          <input className="field-input" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {error && <p className="text-red-400">{error}</p>}
        <Button variant="primary" className="w-full" loading={busy} type="submit">{setup ? t('Create and sign in') : t('Sign in')}</Button>
      </form>
    </div>
  );
}
