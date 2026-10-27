import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Mail, Pencil, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { Avatar, Button, Field, Modal, Toggle, useToast } from '../components/ui';
import { api } from '../lib/api';
import { can, useCan, useMe, useRoles, useUsers, useWorkspaces } from '../lib/queries';
import type { EmailSettings, GitInfo, Runtime, User } from '../lib/types';
import { timeAgo } from '../lib/format';

export const Page = ({ children }: { children: React.ReactNode }) => (
  <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-3xl space-y-8 p-4 pb-24 md:p-8">{children}</div>
  </div>
);

export function AccountPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return <Page><Profile me={me} /></Page>;
}

export function UsersPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return <Page><Members me={me} /></Page>;
}

export function ServerPage() {
  const settings = useCan('settings.manage');
  return (
    <Page>
      <h1 className="text-lg font-semibold">Servidor</h1>
      {settings && <EmailConfig />}
      <GitSection />
      <Runtimes />
    </Page>
  );
}

// Como o servidor fala com o git: chave SSH, helper de credenciais, gh.
function GitSection() {
  const { data } = useQuery({ queryKey: ['git'], queryFn: () => api.get<GitInfo>('/git'), staleTime: 60_000 });
  const toast = useToast();
  if (!data) return null;
  const ok = !!(data.sshKey || data.credentialHelper || data.gh);
  return (
    <section>
      <h2 className="mb-1 font-semibold">Acesso ao git</h2>
      <p className="mb-3 text-xs text-mute">O Multica clona e publica com as credenciais git do usuário que roda o servidor ({data.home}). Ao salvar um repositório, ele testa o acesso com <code>git ls-remote</code>.</p>
      <div className="space-y-3 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="flex items-center gap-2">{ok ? <CheckCircle2 className="size-4 text-emerald-400" /> : <XCircle className="size-4 text-amber-400" />}<span>{data.version}</span></div>
        <div className="grid gap-1 text-xs text-dim">
          <div>Chave SSH: {data.sshKey ? <span className="text-emerald-400">encontrada</span> : <span className="text-mute">nenhuma em ~/.ssh</span>}</div>
          <div>Credential helper (HTTPS): {data.credentialHelper ? <span className="font-mono text-emerald-400">{data.credentialHelper}</span> : <span className="text-mute">não configurado</span>}</div>
          <div>GitHub CLI (gh): {data.gh ? <span className="text-emerald-400">autenticado</span> : <span className="text-mute">não autenticado</span>}</div>
        </div>
        {data.sshKey && (
          <div>
            <div className="mb-1 text-xs text-mute">Chave pública (cadastre como deploy key com escrita, ou na sua conta):</div>
            <pre onClick={() => { navigator.clipboard?.writeText(data.sshKey!); toast('success', 'Chave copiada'); }} className="cursor-copy overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line bg-card p-2 font-mono text-[11px] text-dim">{data.sshKey}</pre>
          </div>
        )}
        {!ok && <p className="text-xs text-amber-400">Sem credenciais: só repositórios públicos funcionam para leitura, e o push vai falhar. Veja "Acesso aos repositórios" no README.</p>}
      </div>
    </section>
  );
}

function Profile({ me }: { me: User }) {
  const [form, setForm] = useState({ name: me.name, about: me.about, password: '' });
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const save = async () => {
    setBusy(true);
    try {
      const u = await api.patch<User>('/me', form);
      qc.setQueryData(['me'], u);
      qc.invalidateQueries({ queryKey: ['users'] });
      setForm((f) => ({ ...f, password: '' }));
      toast('success', 'Perfil salvo');
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h1 className="mb-4 text-lg font-semibold">Perfil</h1>
      <div className="space-y-4 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center gap-3"><Avatar name={me.name} size={40} /><div><div className="font-medium">{me.name}</div><div className="text-xs text-mute">{me.email}</div></div></div>
        <Field label="Nome"><input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Sobre você" hint="vai junto em toda execução que você pedir">
          <textarea className="field-input" rows={3} maxLength={2000} value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} placeholder="Ex.: dev backend (Java + Postgres). Prefiro PRs enxutos e testes junto da mudança." />
        </Field>
        <Field label="Nova senha" hint="deixe vazio para manter"><input className="field-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <EmailToggle me={me} />
        <div className="flex justify-end"><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></div>
      </div>
    </section>
  );
}

const useEmailSettings = () => useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<EmailSettings>('/settings/email') });

// Preferência pessoal: salva na hora, sem depender do botão do perfil.
function EmailToggle({ me }: { me: User }) {
  const { data } = useEmailSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const set = async (on: boolean) => {
    try {
      const u = await api.patch<User>('/me', { emailNotifications: on });
      qc.setQueryData(['me'], u);
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  return (
    <div className="space-y-1">
      <Toggle checked={me.emailNotifications} onChange={set} label="Receber e-mail quando criarem issue nos meus workspaces" />
      {data && !data.enabled && <p className="pl-9 text-xs text-mute">O admin ainda não ligou os e-mails; quando ligar, vale esta escolha.</p>}
    </div>
  );
}

// "5 min" -> "há 5 min"; "agora" e datas ficam como estão.
const since = (iso: string | null) => { const t = timeAgo(iso); return /^\d+ /.test(t) ? `há ${t}` : t; };

const EMAIL_PRESETS: Record<string, Partial<EmailSettings>> = {
  Gmail: { host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  Outlook: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
  'Porta 465': { port: 465, security: 'tls' }
};

function EmailConfig() {
  const { data } = useEmailSettings();
  if (!data) return null;
  return <EmailForm key={String(data.hasPassword) + data.host} initial={data} />;
}

function EmailForm({ initial }: { initial: EmailSettings }) {
  const [f, setF] = useState<EmailSettings>({ ...initial, password: '', appUrl: initial.appUrl || window.location.origin });
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const qc = useQueryClient();
  const toast = useToast();
  const up = (p: Partial<EmailSettings>) => setF((x) => ({ ...x, ...p }));
  const run = async (kind: 'save' | 'test', body: EmailSettings) => {
    setBusy(kind);
    try {
      if (kind === 'test') {
        const r = await api.post<{ sentTo: string }>('/settings/email/test', body);
        toast('success', `E-mail de teste enviado para ${r.sentTo}`);
      } else {
        const saved = await api.put<EmailSettings>('/settings/email', body);
        qc.setQueryData(['email-settings'], saved);
        toast('success', body.enabled ? 'E-mails ligados: issue nova avisa o workspace' : 'Configuração salva (e-mails desligados)');
      }
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy('');
      qc.invalidateQueries({ queryKey: ['email-settings'] });
    }
  };
  const st = initial.status;
  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 font-semibold"><Mail className="size-4" /> E-mail de notificação</h2>
      <p className="mb-3 text-xs text-mute">
        Quando alguém cria uma issue, todos do workspace recebem um e-mail (menos quem desligou no perfil e quem criou).
        O assunto é sempre <span className="font-mono">[Multica] nome do workspace</span>, então cada workspace vira uma conversa só na caixa de entrada.
      </p>
      <div className="space-y-4 rounded-xl border border-line bg-panel p-4">
        <Toggle checked={f.enabled} onChange={(enabled) => up({ enabled })} label={f.enabled ? 'Ligado: avisa todo mundo' : 'Desligado: ninguém recebe'} />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-mute">Preencher:</span>
          {Object.entries(EMAIL_PRESETS).map(([name, p]) => (
            <button key={name} type="button" onClick={() => up(p)} className="rounded-full border border-line px-2.5 py-0.5 text-dim hover:bg-hover">{name}</button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_6rem_9rem]">
          <Field label="Servidor SMTP"><input className="field-input" value={f.host} onChange={(e) => up({ host: e.target.value })} placeholder="smtp.gmail.com" /></Field>
          <Field label="Porta"><input className="field-input" type="number" value={f.port || ''} onChange={(e) => up({ port: Number(e.target.value) })} /></Field>
          <Field label="Segurança">
            <select className="field-input" value={f.security} onChange={(e) => up({ security: e.target.value as EmailSettings['security'] })}>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">Nenhuma</option>
            </select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Usuário" hint="vazio se não exige login"><input className="field-input" autoComplete="off" value={f.username} onChange={(e) => up({ username: e.target.value })} /></Field>
          <Field label="Senha" hint={initial.hasPassword ? 'salva; vazio mantém' : 'no Gmail, use senha de app'}>
            <input className="field-input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => up({ password: e.target.value })} placeholder={initial.hasPassword ? '••••••••' : ''} />
          </Field>
          <Field label="E-mail de envio"><input className="field-input" type="email" value={f.from} onChange={(e) => up({ from: e.target.value })} placeholder="multica@empresa.com" /></Field>
          <Field label="Nome do remetente"><input className="field-input" value={f.fromName} onChange={(e) => up({ fromName: e.target.value })} /></Field>
        </div>
        <Field label="Endereço do Multica" hint="usado nos links do e-mail"><input className="field-input" value={f.appUrl} onChange={(e) => up({ appUrl: e.target.value })} /></Field>
        {st && (st.lastError || st.lastSentAt) && (
          <div className="text-xs">
            {st.lastSentAt && <div className="text-emerald-400">Último envio: {since(st.lastSentAt)}</div>}
            {st.lastError && (!st.lastSentAt || (st.lastErrorAt ?? '') > st.lastSentAt) && <div className="text-red-400">Última falha ({since(st.lastErrorAt)}): {st.lastError}</div>}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button loading={busy === 'test'} onClick={() => run('test', f)}><Send className="size-3.5" /> Enviar teste para mim</Button>
          <Button variant="primary" loading={busy === 'save'} onClick={() => run('save', f)}>Salvar</Button>
        </div>
      </div>
    </section>
  );
}

function Runtimes() {
  const { data, isLoading } = useQuery({ queryKey: ['runtimes'], queryFn: () => api.get<Runtime[]>('/runtimes'), staleTime: 60_000 });
  return (
    <section>
      <h2 className="mb-1 font-semibold">Runtimes no servidor</h2>
      <p className="mb-3 text-xs text-mute">Os agentes rodam o Claude Code e o Codex instalados no servidor, com o login feito lá (veja o README).</p>
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">
        {isLoading && <div className="p-4 text-mute">Verificando…</div>}
        {data?.map((r) => (
          <div key={r.runtime} className="flex items-center gap-3 p-3">
            {r.installed ? <CheckCircle2 className="size-4 text-emerald-400" /> : <XCircle className="size-4 text-red-400" />}
            <div className="flex-1">
              <div className="font-medium">{r.runtime === 'claude' ? 'Claude Code' : 'Codex'}</div>
              <div className="font-mono text-xs text-mute">{r.installed ? r.version : `${r.bin} não encontrado no PATH`}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Members({ me }: { me: User }) {
  const { data: users = [] } = useUsers();
  const { data: workspaces = [] } = useWorkspaces();
  const [editing, setEditing] = useState<Partial<User> | null>(null);
  const qc = useQueryClient();
  const canCreate = can(me, 'user.create');
  const canUpdate = can(me, 'user.update');
  const canDelete = can(me, 'user.delete');
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? '?';
  return (
    <section>
      <div className="mb-1 flex items-center">
        <h1 className="text-lg font-semibold">Usuários</h1>
        {canCreate && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing({ workspaceIds: [] })}><Plus className="size-3.5" /> Novo usuário</Button>}
      </div>
      <p className="mb-3 text-xs text-mute">Cada pessoa tem um perfil (o que pode fazer) e os workspaces em que trabalha. Quem tem "ver todos os workspaces" não precisa de vínculo.</p>
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 p-3">
            <Avatar name={u.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{u.name} {u.id === me.id && <span className="text-xs text-mute">· você</span>}</div>
              <div className="truncate text-xs text-mute">{u.email}</div>
              <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{u.isOwner ? 'dono · pode tudo' : u.roleName || 'sem perfil'}</span>
                {can(u, 'workspace.all') ? <span className="rounded bg-hover px-1.5 py-0.5 text-dim">todos os workspaces</span>
                  : u.workspaceIds?.length ? u.workspaceIds.map((id) => <span key={id} className="rounded bg-hover px-1.5 py-0.5 text-dim">{wsName(id)}</span>)
                  : <span className="text-amber-400">sem workspace</span>}
              </div>
            </div>
            {canUpdate && (!u.isOwner || me.isOwner) && <button onClick={() => setEditing(u)} className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><Pencil className="size-4" /></button>}
            {canDelete && u.id !== me.id && !u.isOwner && (
              <button onClick={async () => { if (confirm(`Remover ${u.name}?`)) { await api.del(`/users/${u.id}`); qc.invalidateQueries({ queryKey: ['users'] }); } }} className="rounded p-1.5 text-mute hover:bg-hover hover:text-red-400"><Trash2 className="size-4" /></button>
            )}
          </div>
        ))}
      </div>
      {editing && <UserModal user={editing} isSelf={editing.id === me.id} onClose={() => setEditing(null)} />}
    </section>
  );
}

function UserModal({ user, isSelf, onClose }: { user: Partial<User>; isSelf: boolean; onClose: () => void }) {
  const { data: workspaces = [] } = useWorkspaces();
  const { data: roles = [] } = useRoles();
  const defaultRole = roles.find((r) => r.name === 'Membro')?.id ?? roles[0]?.id ?? '';
  const [u, setU] = useState({ name: user.name ?? '', email: user.email ?? '', password: '', roleId: user.roleId ?? '', workspaceIds: user.workspaceIds ?? [] });
  const roleId = u.roleId || defaultRole;
  const seesAll = !!roles.find((r) => r.id === roleId)?.permissions.includes('workspace.all') || !!user.isOwner;
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const toggleWs = (id: string) => setU({ ...u, workspaceIds: u.workspaceIds.includes(id) ? u.workspaceIds.filter((x) => x !== id) : [...u.workspaceIds, id] });
  const save = async () => {
    setBusy(true);
    try {
      if (user.id) {
        await api.patch(`/users/${user.id}`, { name: u.name, roleId, password: u.password, workspaceIds: u.workspaceIds });
        toast('success', u.password ? 'Usuário salvo; a senha nova já vale e as sessões dele foram encerradas' : 'Usuário salvo');
      } else {
        await api.post('/users', { ...u, roleId });
        toast('success', 'Usuário criado. Passe o e-mail e a senha para a pessoa.');
      }
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['members'] });
      if (isSelf) qc.invalidateQueries({ queryKey: ['me'] });
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={user.id ? `Editar ${user.name}` : 'Novo usuário'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="space-y-4">
        <Field label="Nome"><input autoFocus className="field-input" value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} /></Field>
        <Field label="E-mail"><input className="field-input" type="email" value={u.email} disabled={!!user.id} onChange={(e) => setU({ ...u, email: e.target.value })} /></Field>
        <Field label={user.id ? 'Redefinir senha' : 'Senha inicial'} hint={user.id ? 'vazio mantém a atual' : 'mínimo 8 caracteres'}>
          <input className="field-input" type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} />
        </Field>
        {user.isOwner ? <p className="text-xs text-mute">Dono do Multica: sempre pode tudo.</p> : (
          <Field label="Perfil" hint={isSelf ? 'cuidado: muda as suas permissões' : 'define o que a pessoa pode fazer'}>
            <select className="field-input" value={roleId} onChange={(e) => setU({ ...u, roleId: e.target.value })}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.permissions.length} permissões</option>)}
            </select>
          </Field>
        )}
        {!seesAll && (
          <Field label="Workspaces" hint="onde a pessoa pode trabalhar">
            <div className="flex flex-wrap gap-1.5">
              {workspaces.map((w) => (
                <button key={w.id} type="button" onClick={() => toggleWs(w.id)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${u.workspaceIds.includes(w.id) ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-dim hover:bg-hover'}`}>
                  {w.name}
                </button>
              ))}
              {!workspaces.length && <span className="text-xs text-mute">Nenhum workspace criado ainda.</span>}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
