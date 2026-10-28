import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, IdCard, Mail, Pencil, Plus, Send, Server, Trash2, UserRound, Users, XCircle } from 'lucide-react';
import { Avatar, Button, Field, Modal, PageHeader, Spinner, Toggle, useToast } from '../components/ui';
import { api } from '../lib/api';
import { can, useCan, useMe, usePermissions, useRoles, useUsers, useWorkspaces } from '../lib/queries';
import type { EmailSettings, GitInfo, Runtime, User } from '../lib/types';
import { timeAgo } from '../lib/format';
import { t } from '../lib/i18n';
import { Appearance } from '../components/Prefs';

export const Page = ({ children }: { children: React.ReactNode }) => (
  <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-3xl space-y-8 p-4 pb-24 md:p-8">{children}</div>
  </div>
);

export function AccountPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return <Page><Profile me={me} /><Appearance /></Page>;
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
      <PageHeader icon={Server} title={t('Servidor')} description={t('E-mail de notificação, acesso ao git e runtimes dos agentes.')} />
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
      <h2 className="mb-1 font-semibold">{t('Acesso ao git')}</h2>
      <p className="mb-3 text-xs text-mute">{t('O Multica clona e publica com as credenciais git do usuário que roda o servidor (')}{data.home}{t('). Ao salvar um repositório, ele testa o acesso com')} <code>{t('git ls-remote')}</code>.</p>
      <div className="space-y-3 surface p-4 text-sm">
        <div className="flex items-center gap-2">{ok ? <CheckCircle2 className="size-4 text-emerald-400" /> : <XCircle className="size-4 text-amber-400" />}<span>{data.version}</span></div>
        <div className="grid gap-1 text-xs text-dim">
          <div>{t('Chave SSH:')} {data.sshKey ? <span className="text-emerald-400">{t('encontrada')}</span> : <span className="text-mute">{t('nenhuma em ~/.ssh')}</span>}</div>
          <div>{t('Credential helper (HTTPS):')} {data.credentialHelper ? <span className="font-mono text-emerald-400">{data.credentialHelper}</span> : <span className="text-mute">{t('não configurado')}</span>}</div>
          <div>{t('GitHub CLI (gh):')} {data.gh ? <span className="text-emerald-400">{t('autenticado')}</span> : <span className="text-mute">{t('não autenticado')}</span>}</div>
        </div>
        {data.sshKey && (
          <div>
            <div className="mb-1 text-xs text-mute">{t('Chave pública (cadastre como deploy key com escrita, ou na sua conta):')}</div>
            <pre onClick={() => { navigator.clipboard?.writeText(data.sshKey!); toast('success', t('Chave copiada')); }} className="cursor-copy overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line bg-card p-2 font-mono text-[11px] text-dim">{data.sshKey}</pre>
          </div>
        )}
        {!ok && <p className="text-xs text-amber-400">{t('Sem credenciais: só repositórios públicos funcionam para leitura, e o push vai falhar. Veja "Acesso aos repositórios" no README.')}</p>}
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
      toast('success', t('Perfil salvo'));
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <PageHeader icon={UserRound} title={t('Minha conta')} description={t('Seu nome, senha, contexto para os agentes e notificações.')} />
      <div className="space-y-4 surface p-4">
        <div className="flex items-center gap-3"><Avatar name={me.name} size={40} /><div><div className="font-medium">{me.name}</div><div className="text-xs text-mute">{me.email}</div></div></div>
        <Field label={t('Nome')}><input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={t('Sobre você')} hint={t('vai junto em toda execução que você pedir')}>
          <textarea className="field-input" rows={3} maxLength={2000} value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} placeholder={t('Ex.: dev backend (Java + Postgres). Prefiro PRs enxutos e testes junto da mudança.')} />
        </Field>
        <Field label={t('Nova senha')} hint={t('deixe vazio para manter')}><input className="field-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <EmailToggle me={me} />
        <div className="flex justify-end"><Button variant="primary" loading={busy} onClick={save}>{t('Salvar')}</Button></div>
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
      <Toggle checked={me.emailNotifications} onChange={set} label={t('Receber e-mail quando criarem issue nos meus workspaces')} />
      {data && !data.enabled && <p className="pl-9 text-xs text-mute">{t('O admin ainda não ligou os e-mails; quando ligar, vale esta escolha.')}</p>}
    </div>
  );
}

// "5 min" -> "há 5 min"; "agora" e datas ficam como estão.
const since = (iso: string | null) => { const tt = timeAgo(iso); return /^\d+ /.test(tt) ? t('há {0}', tt) : tt; };

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
        toast('success', t('E-mail de teste enviado para {0}', r.sentTo));
      } else {
        const saved = await api.put<EmailSettings>('/settings/email', body);
        qc.setQueryData(['email-settings'], saved);
        toast('success', body.enabled ? t('E-mails ligados: issue nova avisa o workspace') : t('Configuração salva (e-mails desligados)'));
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
      <h2 className="mb-1 flex items-center gap-2 font-semibold"><Mail className="size-4" /> {t('E-mail de notificação')}</h2>
      <p className="mb-3 text-xs text-mute">
        {t('Quando alguém cria uma issue, todos do workspace recebem um e-mail (menos quem desligou no perfil e quem criou). O assunto é sempre')} <span className="font-mono">{t('[Multica] nome do workspace')}</span>{t(', então cada workspace vira uma conversa só na caixa de entrada.')}
      </p>
      <div className="space-y-4 surface p-4">
        <Toggle checked={f.enabled} onChange={(enabled) => up({ enabled })} label={f.enabled ? t('Ligado: avisa todo mundo') : t('Desligado: ninguém recebe')} />
        {!f.enabled && (initial.notifyRules ?? 0) > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" />
            {t('Há')} {initial.notifyRules} {t('regra(s) de e-mail nos fluxos que não enviam nada enquanto o envio estiver desligado. Ligue e configure abaixo.')}
          </div>
        )}
        {!f.enabled ? (
          initial.enabled && <div className="flex justify-end"><Button variant="primary" loading={busy === 'save'} onClick={() => run('save', f)}>{t('Salvar (desligar)')}</Button></div>
        ) : <>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-mute">{t('Preencher:')}</span>
          {Object.entries(EMAIL_PRESETS).map(([name, p]) => (
            <button key={name} type="button" onClick={() => up(p)} className="rounded-full border border-line px-2.5 py-0.5 text-dim hover:bg-hover">{name}</button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_6rem_9rem]">
          <Field label={t('Servidor SMTP')}><input className="field-input" value={f.host} onChange={(e) => up({ host: e.target.value })} placeholder={t('smtp.gmail.com')} /></Field>
          <Field label={t('Porta')}><input className="field-input" type="number" value={f.port || ''} onChange={(e) => up({ port: Number(e.target.value) })} /></Field>
          <Field label={t('Segurança')}>
            <select className="field-input" value={f.security} onChange={(e) => up({ security: e.target.value as EmailSettings['security'] })}>
              <option value="starttls">{t('STARTTLS')}</option>
              <option value="tls">{t('TLS')}</option>
              <option value="none">{t('Nenhuma')}</option>
            </select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Usuário')} hint={t('vazio se não exige login')}><input className="field-input" autoComplete="off" value={f.username} onChange={(e) => up({ username: e.target.value })} /></Field>
          <Field label={t('Senha')} hint={initial.hasPassword ? t('salva; vazio mantém') : t('no Gmail, use senha de app')}>
            <input className="field-input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => up({ password: e.target.value })} placeholder={initial.hasPassword ? '••••••••' : ''} />
          </Field>
          <Field label={t('E-mail de envio')}><input className="field-input" type="email" value={f.from} onChange={(e) => up({ from: e.target.value })} placeholder={t('multica@empresa.com')} /></Field>
          <Field label={t('Nome do remetente')}><input className="field-input" value={f.fromName} onChange={(e) => up({ fromName: e.target.value })} /></Field>
        </div>
        <Field label={t('Endereço do Multica')} hint={t('usado nos links do e-mail')}><input className="field-input" value={f.appUrl} onChange={(e) => up({ appUrl: e.target.value })} /></Field>
        {st && (st.lastError || st.lastSentAt) && (
          <div className="text-xs">
            {st.lastSentAt && <div className="text-emerald-400">{t('Último envio:')} {since(st.lastSentAt)}</div>}
            {st.lastError && (!st.lastSentAt || (st.lastErrorAt ?? '') > st.lastSentAt) && <div className="text-red-400">{t('Última falha (')}{since(st.lastErrorAt)}): {st.lastError}</div>}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button loading={busy === 'test'} onClick={() => run('test', f)}><Send className="size-3.5" /> {t('Enviar teste para mim')}</Button>
          <Button variant="primary" loading={busy === 'save'} onClick={() => run('save', f)}>{t('Salvar')}</Button>
        </div>
        </>}
      </div>
    </section>
  );
}

function Runtimes() {
  const { data, isLoading } = useQuery({ queryKey: ['runtimes'], queryFn: () => api.get<Runtime[]>('/runtimes'), staleTime: 60_000 });
  return (
    <section>
      <h2 className="mb-1 font-semibold">{t('Runtimes no servidor')}</h2>
      <p className="mb-3 text-xs text-mute">{t('Os agentes rodam o Claude Code e o Codex instalados no servidor, com o login feito lá (veja o README).')}</p>
      <div className="divide-y divide-line surface">
        {isLoading && <div className="p-4 text-mute">{t('Verificando…')}</div>}
        {data?.map((r) => (
          <div key={r.runtime} className="flex items-center gap-3 p-3">
            {r.installed ? <CheckCircle2 className="size-4 text-emerald-400" /> : <XCircle className="size-4 text-red-400" />}
            <div className="flex-1">
              <div className="font-medium">{r.runtime === 'claude' ? t('Claude Code') : t('Codex')}</div>
              <div className="font-mono text-xs text-mute">{r.installed ? r.version : t('{0} não encontrado no PATH', r.bin)}</div>
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
  const [viewing, setViewing] = useState<User | null>(null);
  const qc = useQueryClient();
  const canCreate = can(me, 'user.create');
  const canUpdate = can(me, 'user.update');
  const canDelete = can(me, 'user.delete');
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? t('outro workspace');
  return (
    <section>
      <PageHeader icon={Users} title={t('Usuários')} description={t('Cada pessoa tem um perfil (o que pode fazer) e os workspaces em que trabalha. Quem tem "ver todos os workspaces" não precisa de vínculo.')}
        actions={canCreate && <Button variant="primary" onClick={() => setEditing({ workspaceIds: [] })}><Plus className="size-4" /> {t('Novo usuário')}</Button>} />
      <div className="divide-y divide-line surface">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 p-3">
            <Avatar name={u.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{u.name} {u.id === me.id && <span className="text-xs text-mute">{t('· você')}</span>}</div>
              <div className="truncate text-xs text-mute">{u.email}</div>
              <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{u.isOwner ? t('dono · pode tudo') : u.roleName || t('sem perfil')}</span>
                {can(u, 'workspace.all') ? <span className="rounded bg-hover px-1.5 py-0.5 text-dim">{t('todos os workspaces')}</span>
                  : u.workspaceIds?.length ? u.workspaceIds.map((id) => <span key={id} className="rounded bg-hover px-1.5 py-0.5 text-dim">{wsName(id)}</span>)
                  : <span className="text-amber-400">{t('sem workspace')}</span>}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setViewing(u)}><IdCard className="size-3.5" /> <span className="hidden sm:inline">{t('Ver perfil')}</span></Button>
            {canUpdate && (!u.isOwner || me.isOwner) && <button onClick={() => setEditing(u)} className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><Pencil className="size-4" /></button>}
            {canDelete && u.id !== me.id && !u.isOwner && (
              <button onClick={async () => { if (confirm(t('Remover {0}?', u.name))) { await api.del(`/users/${u.id}`); qc.invalidateQueries({ queryKey: ['users'] }); } }} className="rounded p-1.5 text-mute hover:bg-hover hover:text-red-400"><Trash2 className="size-4" /></button>
            )}
          </div>
        ))}
      </div>
      {editing && <UserModal user={editing} isSelf={editing.id === me.id} onClose={() => setEditing(null)} />}
      {viewing && <ProfileModal user={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

interface ProfileData {
  user: User;
  allWorkspaces: boolean;
  workspaces: { id: string; name: string; key: string; roles: string[]; rules: number; open: number; created: number; resolved: number }[];
}

// Perfil de uma pessoa: quem é, o que pode fazer e onde atua em cada workspace.
function ProfileModal({ user, onClose }: { user: User; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['profile', user.id], queryFn: () => api.get<ProfileData>(`/users/${user.id}/profile`) });
  const { data: catalog = [] } = usePermissions();
  const u = data?.user ?? user;
  const owner = u.isOwner || u.permissions.includes('*');
  const groups = [...new Set(catalog.map((p) => p.group))]
    .map((g) => ({ g, items: catalog.filter((p) => p.group === g && (owner || u.permissions.includes(p.id))) }))
    .filter((x) => x.items.length);
  return (
    <Modal open wide onClose={onClose} title={t('Perfil')}>
      <div className="space-y-5">
        <div className="flex items-start gap-3">
          <Avatar name={u.name} size={44} />
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold">{u.name}</div>
            <div className="truncate text-xs text-mute">{u.email}</div>
            <div className="mt-1.5 flex flex-wrap gap-1 text-[11px]">
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-accent">{owner ? t('dono · pode tudo') : u.roleName || t('sem perfil')}</span>
              {data?.allWorkspaces && <span className="rounded bg-hover px-1.5 py-0.5 text-dim">{t('vê todos os workspaces')}</span>}
            </div>
          </div>
        </div>
        {u.about?.trim() && <p className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[13px] text-dim">{u.about}</p>}

        <div>
          <div className="mb-2 text-xs font-medium text-dim">{t('Onde atua')}</div>
          {!data ? <Spinner /> : data.workspaces.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {data.workspaces.map((w) => (
                <div key={w.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <div className="flex items-center gap-2">
                    <span className="grid size-6 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent/60 text-[11px] font-bold text-snow">{w.name[0]}</span>
                    <span className="font-medium">{w.name}</span>
                    <span className="font-mono text-[10px] text-mute">{w.key}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-dim"><b className="text-fg">{w.open}</b> {t('aberta(s) com ela')}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-dim"><b className="text-fg">{w.resolved}</b> {t('resolvida(s)')}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-dim"><b className="text-fg">{w.created}</b> {t('criada(s)')}</span>
                  </div>
                  {w.roles.length > 0 ? (
                    <ul className="mt-2 space-y-0.5 text-xs text-dim">
                      {w.roles.map((r) => <li key={r} className="flex gap-1.5"><span className="text-accent">•</span>{r}</li>)}
                    </ul>
                  ) : <p className="mt-2 text-xs text-mute">{t('Sem papel fixo em etapas: atua conforme as permissões do perfil.')}</p>}
                  {w.rules > 0 && <p className="mt-1 text-[11px] text-mute">{t('Citada em')} {w.rules} {t('regra(s) de automação.')}</p>}
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-mute">{t('Sem workspaces em comum com você.')}</p>}
        </div>

        <div>
          <div className="mb-2 text-xs font-medium text-dim">{t('O que pode fazer')}</div>
          {owner ? <p className="text-xs text-mute">{t('Tudo: é o dono do Multica.')}</p> : groups.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {groups.map(({ g, items }) => (
                <div key={g}>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-mute">{g}</div>
                  <ul className="space-y-0.5 text-xs text-dim">{items.map((p) => <li key={p.id} className="flex gap-1.5"><Check className="mt-0.5 size-3 shrink-0 text-emerald-400" />{p.label}</li>)}</ul>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-mute">{t('Nenhuma permissão: só vê os workspaces dele.')}</p>}
        </div>
      </div>
    </Modal>
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
        toast('success', u.password ? t('Usuário salvo; a senha nova já vale e as sessões dele foram encerradas') : t('Usuário salvo'));
      } else {
        await api.post('/users', { ...u, roleId });
        toast('success', t('Usuário criado. Passe o e-mail e a senha para a pessoa.'));
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
    <Modal open onClose={onClose} title={user.id ? t('Editar {0}', user.name) : t('Novo usuário')} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancelar')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('Salvar')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('Nome')}><input autoFocus className="field-input" value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} /></Field>
        <Field label={t('E-mail')}><input className="field-input" type="email" value={u.email} disabled={!!user.id} onChange={(e) => setU({ ...u, email: e.target.value })} /></Field>
        <Field label={user.id ? t('Redefinir senha') : t('Senha inicial')} hint={user.id ? t('vazio mantém a atual') : t('mínimo 8 caracteres')}>
          <input className="field-input" type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} />
        </Field>
        {user.isOwner ? <p className="text-xs text-mute">{t('Dono do Multica: sempre pode tudo.')}</p> : (
          <Field label={t('Perfil')} hint={isSelf ? t('cuidado: muda as suas permissões') : t('define o que a pessoa pode fazer')}>
            <select className="field-input" value={roleId} onChange={(e) => setU({ ...u, roleId: e.target.value })}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.permissions.length} {t('permissões')}</option>)}
            </select>
          </Field>
        )}
        {!seesAll && (
          <Field label={t('Workspaces')} hint={t('onde a pessoa pode trabalhar')}>
            <div className="flex flex-wrap gap-1.5">
              {workspaces.map((w) => (
                <button key={w.id} type="button" onClick={() => toggleWs(w.id)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${u.workspaceIds.includes(w.id) ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-dim hover:bg-hover'}`}>
                  {w.name}
                </button>
              ))}
              {!workspaces.length && <span className="text-xs text-mute">{t('Nenhum workspace criado ainda.')}</span>}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
