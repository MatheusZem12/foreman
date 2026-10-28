import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, FolderGit2, GitBranch, Plus, Tag, UserRound } from 'lucide-react';
import { Avatar, Chip, MenuItem, Popover, PriorityIcon, StatusIcon } from './ui';
import { LABEL_COLORS, PRIORITIES, STATUSES, statusOf } from '../lib/constants';
import { useAgents, useBranches, useLabels, useMembers, useRepos, useStages } from '../lib/queries';
import { useWs } from './Layout';
import { api } from '../lib/api';
import type { Label, Status } from '../lib/types';
import { AgentIcon } from './AgentIcon';

type Variant = 'chip' | 'row';

// Gatilho comum: chip compacto (criação/cartões) ou linha da barra de propriedades.
function Trigger({ variant, children }: { variant: Variant; children: React.ReactNode }) {
  if (variant === 'row') {
    return <button type="button" className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-hover">{children}</button>;
  }
  return <Chip>{children}</Chip>;
}

export function StatusPicker({ value, onChange, variant = 'chip' }: { value: Status; onChange: (s: Status) => void; variant?: Variant }) {
  useStages(useWs().ws.id); // re-renderiza quando as etapas do workspace mudam
  return (
    <Popover trigger={() => <Trigger variant={variant}><StatusIcon status={value} /><span className="truncate">{statusOf(value).label}</span></Trigger>}>
      {(close) =>
        STATUSES.map((s) => (
          <MenuItem key={s.id} selected={s.id === value} onClick={() => { onChange(s.id); close(); }}>
            <StatusIcon status={s.id} /> {s.label}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

export function PriorityPicker({ value, onChange, variant = 'chip' }: { value: number; onChange: (p: number) => void; variant?: Variant }) {
  const current = PRIORITIES.find((p) => p.id === value) ?? PRIORITIES[0];
  return (
    <Popover trigger={() => <Trigger variant={variant}><PriorityIcon priority={value} /><span className="truncate">{current.label}</span></Trigger>}>
      {(close) =>
        PRIORITIES.map((p) => (
          <MenuItem key={p.id} selected={p.id === value} onClick={() => { onChange(p.id); close(); }}>
            <PriorityIcon priority={p.id} /> {p.label}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

// Responsável humano: só quem tem acesso ao workspace.
export function AssigneePicker({ ws, value, onChange, variant = 'chip' }: { ws: string; value: string | null; onChange: (id: string | null) => void; variant?: Variant }) {
  const { data: members = [] } = useMembers(ws);
  const current = members.find((m) => m.id === value);
  return (
    <Popover
      trigger={() => (
        <Trigger variant={variant}>
          {current ? <Avatar name={current.name} /> : <UserRound className="size-3.5 text-mute" />}
          <span className="truncate">{current ? current.name : 'Sem responsável'}</span>
        </Trigger>
      )}
    >
      {(close) => (
        <>
          <MenuItem selected={!value} onClick={() => { onChange(null); close(); }}><UserRound className="size-3.5 text-mute" /> Sem responsável</MenuItem>
          {members.map((m) => (
            <MenuItem key={m.id} selected={m.id === value} onClick={() => { onChange(m.id); close(); }}>
              <Avatar name={m.name} /> <span className="truncate">{m.name}</span>
              <span className="ml-auto pl-2 text-xs text-mute">{m.isOwner ? 'dono' : m.roleName}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

export function AgentPicker({ value, onChange, variant = 'chip', allowNone = true }: { value: string | null; onChange: (id: string | null) => void; variant?: Variant; allowNone?: boolean }) {
  const { data: agents = [] } = useAgents();
  const current = agents.find((a) => a.id === value);
  return (
    <Popover
      trigger={() => (
        <Trigger variant={variant}>
          {current ? <AgentIcon avatar={current.avatar} /> : <Bot className="size-3.5 text-mute" />}
          <span className="truncate">{current ? current.name : 'Sem agente'}</span>
        </Trigger>
      )}
    >
      {(close) => (
        <>
          {allowNone && <MenuItem selected={!value} onClick={() => { onChange(null); close(); }}><Bot className="size-3.5 text-mute" /> Sem agente</MenuItem>}
          {agents.map((a) => (
            <MenuItem key={a.id} selected={a.id === value} onClick={() => { onChange(a.id); close(); }}>
              <AgentIcon avatar={a.avatar} /> <span className="truncate">{a.name}</span>
              <span className="ml-auto pl-2 text-xs text-mute">{a.model || a.runtime}</span>
            </MenuItem>
          ))}
          {!agents.length && <div className="px-2 py-1.5 text-mute">Crie agentes em Ajustes.</div>}
        </>
      )}
    </Popover>
  );
}

// Escopo de repositórios: vazio = todos (a IA escolhe em quais mexer).
export function RepoScopePicker({ ws, value, onChange, variant = 'chip' }: { ws: string; value: string[]; onChange: (ids: string[]) => void; variant?: Variant }) {
  const { data: repos = [] } = useRepos(ws);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const names = repos.filter((r) => value.includes(r.id)).map((r) => r.name);
  return (
    <Popover
      trigger={() => (
        <Trigger variant={variant}>
          <FolderGit2 className="size-3.5 text-mute" />
          <span className="truncate">{names.length ? names.join(', ') : repos.length > 1 ? 'Todos os repositórios' : repos[0]?.name ?? 'Repositório'}</span>
        </Trigger>
      )}
    >
      {() => (
        <>
          <MenuItem selected={!value.length} onClick={() => onChange([])}>
            <FolderGit2 className="size-3.5 text-mute" /> <span>Todos <span className="text-xs text-mute">· a IA escolhe</span></span>
          </MenuItem>
          {repos.length > 0 && <div className="my-1 border-t border-line" />}
          {repos.map((r) => (
            <MenuItem key={r.id} selected={value.includes(r.id)} onClick={() => toggle(r.id)}>
              <FolderGit2 className="size-3.5 text-mute" />
              <span className="min-w-0"><span className="block truncate">{r.name}</span>{r.description && <span className="block truncate text-xs text-mute">{r.description}</span>}</span>
            </MenuItem>
          ))}
          {!repos.length && <div className="px-2 py-1.5 text-mute">Cadastre repositórios em Workspace.</div>}
        </>
      )}
    </Popover>
  );
}

export function BranchPicker({
  repoId, value, onChange, variant = 'chip', placeholder = 'Branch'
}: { repoId: string | null; value: string; onChange: (b: string) => void; variant?: Variant; placeholder?: string }) {
  const { data: branches, isLoading, error } = useBranches(repoId);
  const [filter, setFilter] = useState('');
  const list = (branches ?? []).filter((b) => b.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Popover
      trigger={() => (
        <Trigger variant={variant}>
          <GitBranch className="size-3.5 text-mute" />
          <span className="truncate font-mono text-[12px]">{value || placeholder}</span>
        </Trigger>
      )}
    >
      {(close) => (
        <>
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…" className="field-input mb-1 h-7" />
          {isLoading && <div className="px-2 py-1.5 text-mute">Carregando branches…</div>}
          {error && <div className="px-2 py-1.5 text-red-400">{(error as Error).message}</div>}
          {list.slice(0, 60).map((b) => (
            <MenuItem key={b} selected={b === value} onClick={() => { onChange(b); close(); }}>
              <span className="truncate font-mono text-[12px]">{b}</span>
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

export function LabelDots({ ids, labels }: { ids: string[]; labels: Label[] }) {
  const items = ids.map((id) => labels.find((l) => l.id === id)).filter(Boolean) as Label[];
  if (!items.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((l) => (
        <span key={l.id} className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-px text-[11px] text-dim">
          <span className="size-1.5 rounded-full" style={{ background: l.color }} /> {l.name}
        </span>
      ))}
    </span>
  );
}

export function LabelPicker({ ws, value, onChange, variant = 'chip' }: { ws: string; value: string[]; onChange: (ids: string[]) => void; variant?: Variant }) {
  const { data: labels = [] } = useLabels(ws);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const create = async () => {
    if (!name.trim()) return;
    const color = LABEL_COLORS[labels.length % LABEL_COLORS.length];
    const l = await api.post<Label>(`/workspaces/${ws}/labels`, { name: name.trim(), color });
    qc.setQueryData<Label[]>(['labels', ws], (old) => [...(old ?? []).filter((x) => x.id !== l.id), l]);
    onChange([...value, l.id]);
    setName('');
  };
  const selected = labels.filter((l) => value.includes(l.id));
  return (
    <Popover
      trigger={() => (
        <Trigger variant={variant}>
          <Tag className="size-3.5 text-mute" />
          <span className="truncate">{selected.length ? selected.map((l) => l.name).join(', ') : 'Labels'}</span>
        </Trigger>
      )}
    >
      {() => (
        <>
          <form onSubmit={(e) => { e.preventDefault(); create(); }} className="mb-1 flex gap-1">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova label…" className="field-input h-7" />
            <button type="submit" className="rounded-md px-1.5 text-mute hover:bg-hover hover:text-fg"><Plus className="size-4" /></button>
          </form>
          {labels.map((l) => (
            <MenuItem key={l.id} selected={value.includes(l.id)} onClick={() => toggle(l.id)}>
              <span className="size-2 rounded-full" style={{ background: l.color }} /> {l.name}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}
