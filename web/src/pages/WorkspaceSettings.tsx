import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderCog, FolderGit2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, Button, Empty, Field, Modal, PageHeader, useToast, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { can, useCan, useMembers, useRepos, useUsers } from '../lib/queries';
import type { Repo } from '../lib/types';
import { t } from '../lib/i18n';

export function WorkspaceSettings() {
  const ask = useConfirm();
  const { ws } = useWs();
  const { data: repos = [] } = useRepos(ws.id);
  const [editing, setEditing] = useState<Partial<Repo> | null>(null);
  const [name, setName] = useState(ws.name);
  const qc = useQueryClient();
  const toast = useToast();
  const canRename = useCan('workspace.update');
  const canAddRepo = useCan('repo.create');
  const canEditRepo = useCan('repo.update');
  const canDelRepo = useCan('repo.delete');
  const canMembers = useCan('member.manage');
  const canDelWs = useCan('workspace.delete');

  const saveName = async () => {
    if (!name.trim() || name === ws.name) return;
    await api.patch(`/workspaces/${ws.id}`, { name });
    qc.invalidateQueries({ queryKey: ['workspaces'] });
    toast('success', t('Name saved'));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="page space-y-8">
        <section>
          <PageHeader icon={FolderCog} title={t('Workspace')} description={t('Name, git repositories and people of this workspace.')} />
          <div className="flex items-end gap-2">
            <Field label={t('Name')} className="flex-1"><input className="field-input" value={name} disabled={!canRename} onChange={(e) => setName(e.target.value)} onBlur={saveName} /></Field>
            <Field label={t('Key')}><input className="field-input w-24 font-mono" value={ws.key} disabled /></Field>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center">
            <h2 className="font-semibold">{t('Repositories')}</h2>
            {canAddRepo && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing({})}><Plus className="size-3.5" /> {t('Add')}</Button>}
          </div>
          <p className="mb-3 text-xs text-mute">
            {t('A workspace can have several repositories (front end, back end, mobile…). Each issue gets a worktree of each one and the AI only touches the ones the request needs; each repository\'s')} <b>{t('description')}</b> {t('is what it uses to decide. Only git URLs the server can reach are accepted (SSH, or HTTPS with a token).')}
          </p>
          <div className="space-y-2">
            {repos.map((r) => (
              <div key={r.id} className="surface surface-hover flex items-start gap-3 p-3.5">
                <FolderGit2 className="mt-0.5 size-4 text-mute" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.name}</div>
                  {r.description && <div className="text-xs text-dim">{r.description}</div>}
                  <div className="truncate font-mono text-xs text-mute">{r.url.replace(/\/\/[^@/]+@/, '//***@')}</div>
                </div>
                {canEditRepo && <button onClick={() => setEditing(r)} className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><Pencil className="size-4" /></button>}
                {canDelRepo && <button
                  onClick={async () => {
                    if (!(await ask({ title: t('Remove {0} from the workspace?', r.name), message: t('Issues stay, without this repository.'), danger: true }))) return;
                    await api.del(`/repos/${r.id}`);
                    qc.invalidateQueries({ queryKey: ['repos', ws.id] });
                  }}
                  className="rounded p-1.5 text-mute hover:bg-hover hover:text-red-400"
                ><Trash2 className="size-4" /></button>}
              </div>
            ))}
            {!repos.length && <Empty className="rounded-lg border border-dashed border-line">{t('No repositories. Add one so agents can work.')}</Empty>}
          </div>
        </section>

        {canMembers && <MembersSection wsId={ws.id} />}


        {canDelWs && (
          <section className="rounded-xl border border-red-500/30 p-4">
            <h2 className="font-semibold text-red-400">{t('Delete workspace')}</h2>
            <p className="mb-3 mt-1 text-xs text-mute">{t('Deletes the issues, history and links. Remote repositories aren\'t touched.')}</p>
            <Button variant="danger" onClick={async () => {
              if (!(await ask({ title: t('Delete the workspace "{0}"?', ws.name), message: t('Deletes the issues, history and links. This can\'t be undone.'), confirmText: t('Delete workspace'), danger: true, typeToConfirm: ws.key }))) return;
              await api.del(`/workspaces/${ws.id}`);
              qc.invalidateQueries({ queryKey: ['workspaces'] });
              location.href = '/';
            }}><Trash2 className="size-3.5" /> {t('Delete')}</Button>
          </section>
        )}
      </div>
      {editing && <RepoModal wsId={ws.id} repo={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// Whoever has "see every workspace" sees this one without a link; the others only if linked here.
function MembersSection({ wsId }: { wsId: string }) {
  const { data: members = [] } = useMembers(wsId);
  const { data: users = [] } = useUsers();
  const [pick, setPick] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const available = users.filter((u) => !can(u, 'workspace.all') && !members.some((m) => m.id === u.id));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['members', wsId] });
    qc.invalidateQueries({ queryKey: ['users'] });
  };
  const add = async () => {
    if (!pick) return;
    await api.put(`/workspaces/${wsId}/members/${pick}`, {});
    setPick('');
    refresh();
    toast('success', t('Person added to the workspace'));
  };
  return (
    <section>
      <h2 className="mb-1 font-semibold">{t('Members')}</h2>
      <p className="mb-3 text-xs text-mute">{t('Whoever is added sees and works on this workspace\'s issues. Roles with "see every workspace" already have access. New users are created under Users.')}</p>
      <div className="mb-3 divide-y divide-line rounded-lg border border-line bg-panel">
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 p-2.5">
            <Avatar name={m.name} size={26} />
            <div className="min-w-0 flex-1"><div className="font-medium">{m.name}</div><div className="truncate text-xs text-mute">{m.email}</div></div>
            {can(m, 'workspace.all') ? <span className="text-xs text-mute">{m.isOwner ? t('owner') : m.roleName} {t('· access to all')}</span> : (
              <button onClick={async () => { await api.del(`/workspaces/${wsId}/members/${m.id}`); refresh(); }} className="rounded px-2 py-1 text-xs text-mute hover:bg-hover hover:text-red-400">{t('Remove')}</button>
            )}
          </div>
        ))}
      </div>
      {available.length > 0 && (
        <div className="flex max-w-md gap-2">
          <select className="field-input" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{t('Add person…')}</option>
            {available.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
          <Button onClick={add} disabled={!pick}>{t('Add')}</Button>
        </div>
      )}
    </section>
  );
}

function RepoModal({ wsId, repo, onClose }: { wsId: string; repo: Partial<Repo>; onClose: () => void }) {
  const [r, setR] = useState<Partial<Repo>>(repo);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const set = (p: Partial<Repo>) => setR((x) => ({ ...x, ...p }));

  const save = async () => {
    setBusy(true);
    try {
      const body = r;
      const saved = r.id ? await api.put<Repo>(`/repos/${r.id}`, body) : await api.post<Repo>(`/workspaces/${wsId}/repos`, body);
      qc.invalidateQueries({ queryKey: ['repos', wsId] });
      qc.invalidateQueries({ queryKey: ['branches', saved.id] });
      // The server already validated with git ls-remote; here it clones and lists the branches.
      try {
        const branches = await api.get<string[]>(`/repos/${saved.id}/branches`);
        toast('success', t('Repository OK: {0} branch(es) found', branches.length));
      } catch (err) {
        toast('error', t('Saved, but the clone failed: {0}', (err as Error).message));
      }
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open wide onClose={onClose} title={r.id ? t('Edit {0}', repo.name) : t('Add repository')} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" loading={busy} disabled={!r.url?.trim() || !r.name?.trim()} onClick={save}>{t('Save and test')}</Button></>}>
      <div className="space-y-4">
        <Field label={t('Git URL')} hint={t('SSH or HTTPS; the server clones with its own git credentials')}>
          <input autoFocus className="field-input font-mono text-xs" value={r.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder={t('git@github.com:org/project.git')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
          <Field label={t('Name')}><input className="field-input" value={r.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={t('e.g. api')} /></Field>
          <Field label={t('Description')} hint={t('optional; helps the AI choose the repository')}>
            <input className="field-input" value={r.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder={t('E.g. Go API (orders, payments)')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
