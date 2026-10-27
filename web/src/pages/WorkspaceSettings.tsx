import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderCog, FolderGit2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Avatar, Button, Empty, Field, Modal, PageHeader, useToast } from '../components/ui';
import { api } from '../lib/api';
import { LABEL_COLORS } from '../lib/constants';
import { can, useCan, useLabels, useMembers, useRepos, useUsers } from '../lib/queries';
import type { FileEntry, Label, Repo } from '../lib/types';

export function WorkspaceSettings() {
  const { ws } = useWs();
  const { data: repos = [] } = useRepos(ws.id);
  const { data: labels = [] } = useLabels(ws.id);
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
    toast('success', 'Nome salvo');
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 p-4 pb-24 md:p-8">
        <section>
          <PageHeader icon={FolderCog} title="Workspace" description="Nome, repositórios git, pessoas e labels deste workspace." />
          <div className="flex items-end gap-2">
            <Field label="Nome" className="flex-1"><input className="field-input" value={name} disabled={!canRename} onChange={(e) => setName(e.target.value)} onBlur={saveName} /></Field>
            <Field label="Chave"><input className="field-input w-24 font-mono" value={ws.key} disabled /></Field>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center">
            <h2 className="font-semibold">Repositórios</h2>
            {canAddRepo && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing({ defaultBranch: 'main', targetBranch: '', protectedBranches: [], envFiles: [] })}><Plus className="size-3.5" /> Adicionar</Button>}
          </div>
          <p className="mb-3 text-xs text-mute">
            Um workspace pode ter vários repositórios (front, back, mobile…). Cada issue recebe um worktree de cada um e a IA mexe só nos que o pedido exige;
            a <b>descrição</b> de cada repositório é o que ela usa para decidir. Só são aceitas URLs git acessíveis pelo servidor (SSH ou HTTPS com token).
          </p>
          <div className="space-y-2">
            {repos.map((r) => (
              <div key={r.id} className="surface surface-hover flex items-start gap-3 p-3.5">
                <FolderGit2 className="mt-0.5 size-4 text-mute" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.name}</div>
                  {r.description && <div className="text-xs text-dim">{r.description}</div>}
                  <div className="truncate font-mono text-xs text-mute">{r.url.replace(/\/\/[^@/]+@/, '//***@')}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                    <span className="rounded bg-hover px-1.5 py-0.5 text-dim">base {r.defaultBranch}</span>
                    <span className="rounded bg-hover px-1.5 py-0.5 text-dim">merge em {r.targetBranch}</span>
                    {r.protectedBranches.map((b) => <span key={b} className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-400">🔒 {b}</span>)}
                    {r.setupScript && <span className="rounded bg-hover px-1.5 py-0.5 text-dim">setup</span>}
                    {r.envFiles.length > 0 && <span className="rounded bg-hover px-1.5 py-0.5 text-dim">{r.envFiles.length} arquivo(s) de ambiente</span>}
                  </div>
                </div>
                {canEditRepo && <button onClick={() => setEditing(r)} className="rounded p-1.5 text-mute hover:bg-hover hover:text-fg"><Pencil className="size-4" /></button>}
                {canDelRepo && <button
                  onClick={async () => {
                    if (!confirm(`Remover ${r.name} do workspace? As issues continuam, sem este repositório.`)) return;
                    await api.del(`/repos/${r.id}`);
                    qc.invalidateQueries({ queryKey: ['repos', ws.id] });
                  }}
                  className="rounded p-1.5 text-mute hover:bg-hover hover:text-red-400"
                ><Trash2 className="size-4" /></button>}
              </div>
            ))}
            {!repos.length && <Empty className="rounded-lg border border-dashed border-line">Nenhum repositório. Adicione um para os agentes trabalharem.</Empty>}
          </div>
        </section>

        {canMembers && <MembersSection wsId={ws.id} />}

        <LabelsSection wsId={ws.id} labels={labels} />

        {canDelWs && (
          <section className="rounded-xl border border-red-500/30 p-4">
            <h2 className="font-semibold text-red-400">Excluir workspace</h2>
            <p className="mb-3 mt-1 text-xs text-mute">Apaga as issues, o histórico e os vínculos. Os repositórios remotos não são tocados.</p>
            <Button variant="danger" onClick={async () => {
              if (prompt(`Digite ${ws.key} para excluir o workspace "${ws.name}"`) !== ws.key) return;
              await api.del(`/workspaces/${ws.id}`);
              qc.invalidateQueries({ queryKey: ['workspaces'] });
              location.href = '/';
            }}><Trash2 className="size-3.5" /> Excluir</Button>
          </section>
        )}
      </div>
      {editing && <RepoModal wsId={ws.id} repo={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// Quem tem "ver todos os workspaces" enxerga este sem vínculo; os demais só se vinculados aqui.
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
    toast('success', 'Pessoa vinculada ao workspace');
  };
  return (
    <section>
      <h2 className="mb-1 font-semibold">Membros</h2>
      <p className="mb-3 text-xs text-mute">Quem está vinculado vê e trabalha nas issues deste workspace. Perfis com "ver todos os workspaces" já têm acesso. Usuários novos se criam em Usuários.</p>
      <div className="mb-3 divide-y divide-line rounded-lg border border-line bg-panel">
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 p-2.5">
            <Avatar name={m.name} size={26} />
            <div className="min-w-0 flex-1"><div className="font-medium">{m.name}</div><div className="truncate text-xs text-mute">{m.email}</div></div>
            {can(m, 'workspace.all') ? <span className="text-xs text-mute">{m.isOwner ? 'dono' : m.roleName} · acesso a todos</span> : (
              <button onClick={async () => { await api.del(`/workspaces/${wsId}/members/${m.id}`); refresh(); }} className="rounded px-2 py-1 text-xs text-mute hover:bg-hover hover:text-red-400">Desvincular</button>
            )}
          </div>
        ))}
      </div>
      {available.length > 0 && (
        <div className="flex max-w-md gap-2">
          <select className="field-input" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Vincular pessoa…</option>
            {available.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
          <Button onClick={add} disabled={!pick}>Vincular</Button>
        </div>
      )}
    </section>
  );
}

function LabelsSection({ wsId, labels }: { wsId: string; labels: Label[] }) {
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.post(`/workspaces/${wsId}/labels`, { name, color: LABEL_COLORS[labels.length % LABEL_COLORS.length] });
    setName('');
    qc.invalidateQueries({ queryKey: ['labels', wsId] });
  };
  return (
    <section>
      <h2 className="mb-2 font-semibold">Labels</h2>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {labels.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-2 pr-1 text-xs">
            <span className="size-2 rounded-full" style={{ background: l.color }} /> {l.name}
            <button onClick={async () => { await api.del(`/labels/${l.id}`); qc.invalidateQueries({ queryKey: ['labels', wsId] }); }} className="rounded-full p-0.5 text-mute hover:bg-hover hover:text-fg"><X className="size-3" /></button>
          </span>
        ))}
      </div>
      <form onSubmit={add} className="flex max-w-xs gap-2">
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova label" />
        <Button type="submit">Adicionar</Button>
      </form>
    </section>
  );
}

const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function RepoModal({ wsId, repo, onClose }: { wsId: string; repo: Partial<Repo>; onClose: () => void }) {
  const [r, setR] = useState<Partial<Repo>>(repo);
  const [protectedText, setProtectedText] = useState((repo.protectedBranches ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const set = (p: Partial<Repo>) => setR((x) => ({ ...x, ...p }));
  const env = r.envFiles ?? [];
  const setEnv = (i: number, p: Partial<FileEntry>) => set({ envFiles: env.map((f, j) => (j === i ? { ...f, ...p } : f)) });

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...r, protectedBranches: splitList(protectedText) };
      const saved = r.id ? await api.put<Repo>(`/repos/${r.id}`, body) : await api.post<Repo>(`/workspaces/${wsId}/repos`, body);
      qc.invalidateQueries({ queryKey: ['repos', wsId] });
      qc.invalidateQueries({ queryKey: ['branches', saved.id] });
      // O servidor já validou com git ls-remote; aqui clona e lista as branches.
      try {
        const branches = await api.get<string[]>(`/repos/${saved.id}/branches`);
        toast('success', `Repositório ok: ${branches.length} branch(es) encontradas`);
      } catch (err) {
        toast('error', `Salvo, mas o clone falhou: ${(err as Error).message}`);
      }
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open wide onClose={onClose} title={r.id ? `Editar ${repo.name}` : 'Adicionar repositório'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar e testar</Button></>}>
      <div className="space-y-4">
        <Field label="URL do git"><input autoFocus className="field-input font-mono text-xs" value={r.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="git@github.com:org/projeto.git" /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Nome" hint="opcional"><input className="field-input" value={r.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Branch base"><input className="field-input font-mono text-xs" value={r.defaultBranch ?? ''} onChange={(e) => set({ defaultBranch: e.target.value })} placeholder="dev" /></Field>
          <Field label="Merge padrão em"><input className="field-input font-mono text-xs" value={r.targetBranch ?? ''} onChange={(e) => set({ targetBranch: e.target.value })} placeholder="igual à base" /></Field>
        </div>
        <Field label="Descrição" hint="1 linha: o que tem neste repositório. A IA usa para decidir onde mexer">
          <input className="field-input" value={r.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="Ex.: API REST em Go (pedidos, pagamentos, autenticação)" />
        </Field>
        <Field label="Branches protegidas" hint="o Multica nunca faz merge nelas">
          <input className="field-input font-mono text-xs" value={protectedText} onChange={(e) => setProtectedText(e.target.value)} placeholder="main, hmg" />
        </Field>
        <Field label="Script de setup" hint="roda uma vez em cada worktree novo">
          <textarea className="field-input font-mono text-xs" rows={2} value={r.setupScript ?? ''} onChange={(e) => set({ setupScript: e.target.value })} placeholder="npm ci" />
        </Field>
        <Field label="Instruções do projeto" hint="a IA lê antes de alterar este repositório">
          <textarea className="field-input" rows={3} value={r.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} placeholder="Stack, como rodar os testes, convenções…" />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center text-xs font-medium text-dim">
            Arquivos de ambiente <span className="ml-1 font-normal text-mute">· escritos no worktree (.env etc.), nunca commitados</span>
            <button onClick={() => set({ envFiles: [...env, { path: '.env', content: '' }] })} className="ml-auto rounded p-1 text-mute hover:bg-hover hover:text-fg"><Plus className="size-3.5" /></button>
          </div>
          <div className="space-y-2">
            {env.map((f, i) => (
              <div key={i} className="rounded-md border border-line">
                <div className="flex items-center gap-2 px-2 py-1">
                  <input value={f.path} onChange={(e) => setEnv(i, { path: e.target.value })} className="flex-1 font-mono text-xs" />
                  <button onClick={() => set({ envFiles: env.filter((_, j) => j !== i) })} className="text-mute hover:text-red-400"><Trash2 className="size-3.5" /></button>
                </div>
                <textarea value={f.content} onChange={(e) => setEnv(i, { content: e.target.value })} rows={4} spellCheck={false} className="w-full border-t border-line bg-bg p-2 font-mono text-[12px]" placeholder="CHAVE=valor" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
