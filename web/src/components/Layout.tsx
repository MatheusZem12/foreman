import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart3, Bot, BookOpen, ChevronDown, CircleHelp, FolderCog, LayoutGrid, LogOut, Menu, Plus, Search, Server, ShieldCheck, UserRound, Users, X
} from 'lucide-react';
import { Avatar, Modal, MenuItem, Popover, Spinner } from './ui';
import { NewIssueModal } from './NewIssue';
import { SearchModal } from './SearchModal';
import { CreateWorkspaceForm } from '../pages/Onboarding';
import { can, useIssues, useMe, useWorkspaces } from '../lib/queries';
import { useRealtime } from '../lib/realtime';
import { api } from '../lib/api';
import { LAST_WS } from '../lib/constants';
import type { Status, Workspace } from '../lib/types';

interface Ctx {
  ws: Workspace;
  openNewIssue: (status?: Status) => void;
}
const WorkspaceCtx = createContext<Ctx>(null!);
export const useWs = () => useContext(WorkspaceCtx);

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

export function Layout() {
  const { key } = useParams();
  const { data: workspaces, isLoading } = useWorkspaces();
  const ws = workspaces?.find((w) => w.key === key?.toUpperCase());
  const [drawer, setDrawer] = useState(false);
  const [newIssue, setNewIssue] = useState<{ status: Status } | null>(null);
  const [search, setSearch] = useState(false);
  const loc = useLocation();

  useRealtime(ws?.id);
  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    if (ws) {
      try {
        localStorage.setItem(LAST_WS, ws.key);
      } catch {
        /* sem storage */
      }
    }
  }, [ws]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e)) {
        e.preventDefault();
        setNewIssue({ status: 'todo' });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const ctx = useMemo(() => (ws ? { ws, openNewIssue: (status: Status = 'todo') => setNewIssue({ status }) } : null), [ws]);
  if (isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (!ws || !ctx) return <Navigate to="/" replace />;

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <div className="flex h-full">
        {/* Sidebar fixa no desktop, gaveta no celular */}
        <div className={clsx('fixed inset-0 z-40 bg-black/50 md:hidden', drawer ? 'block' : 'hidden')} onClick={() => setDrawer(false)} />
        <aside
          className={clsx(
            'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-panel transition-transform md:static md:w-56 md:translate-x-0',
            drawer ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <Sidebar ws={ws} workspaces={workspaces!} onSearch={() => setSearch(true)} onNew={() => setNewIssue({ status: 'todo' })} onClose={() => setDrawer(false)} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:hidden">
            <button onClick={() => setDrawer(true)} className="rounded-md p-1.5 text-dim hover:bg-hover"><Menu className="size-5" /></button>
            <span className="font-semibold">{ws.name}</span>
            <button onClick={() => setSearch(true)} className="ml-auto rounded-md p-1.5 text-dim hover:bg-hover"><Search className="size-5" /></button>
          </header>
          <main className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
        </div>

        {/* Botão flutuante de nova issue no celular (fora da página da issue, onde cobriria o comentário) */}
        {!loc.pathname.includes('/issues/') && <button
          onClick={() => setNewIssue({ status: 'todo' })}
          className="fixed bottom-5 right-5 z-30 grid size-12 place-items-center rounded-full bg-accent text-white shadow-xl md:hidden"
          aria-label="Nova issue"
        >
          <Plus className="size-6" />
        </button>}
      </div>
      {newIssue && <NewIssueModal initialStatus={newIssue.status} onClose={() => setNewIssue(null)} />}
      {search && <SearchModal onClose={() => setSearch(false)} />}
    </WorkspaceCtx.Provider>
  );
}

function Sidebar({ ws, workspaces, onSearch, onNew, onClose }: { ws: Workspace; workspaces: Workspace[]; onSearch: () => void; onNew: () => void; onClose: () => void }) {
  const { data: me } = useMe();
  const { data: issues = [] } = useIssues(ws.id);
  const working = issues.filter((i) => i.activeRun).length;
  const nav = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const base = `/w/${ws.key}`;

  const logout = async () => {
    await api.post('/logout');
    qc.clear();
    nav('/login');
  };

  const link = (to: string, icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
    <NavLink
      to={to}
      end={to === base}
      className={({ isActive }) => clsx('flex h-8 items-center gap-2.5 rounded-md px-2 text-dim hover:bg-hover hover:text-fg', isActive && 'bg-hover text-fg')}
    >
      {icon} <span className="flex-1">{label}</span> {extra}
    </NavLink>
  );

  return (
    <>
      <div className="flex items-center gap-1 p-2">
        <Popover
          className="w-60"
          trigger={() => (
            <button className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 hover:bg-hover">
              <span className="grid size-5 shrink-0 place-items-center rounded bg-accent/20 text-[11px] font-bold text-accent">{ws.name[0]}</span>
              <span className="truncate font-semibold">{ws.name}</span>
              <ChevronDown className="ml-auto size-3.5 text-mute" />
            </button>
          )}
        >
          {(close) => (
            <>
              {me && (
                <div className="flex items-center gap-2 border-b border-line px-2 pb-2 pt-1">
                  <Avatar name={me.name} size={26} />
                  <div className="min-w-0"><div className="truncate font-medium">{me.name}</div><div className="truncate text-xs text-mute">{me.email}</div></div>
                </div>
              )}
              <div className="px-2 pb-1 pt-2 text-[11px] text-mute">Workspaces</div>
              {workspaces.map((w) => (
                <MenuItem key={w.id} selected={w.id === ws.id} onClick={() => { nav(`/w/${w.key}`); close(); }}>
                  <span className="grid size-5 place-items-center rounded bg-hover text-[11px] font-bold">{w.name[0]}</span> {w.name}
                </MenuItem>
              ))}
              {can(me, 'workspace.create') && <MenuItem onClick={() => { setCreating(true); close(); }}><Plus className="size-4 text-mute" /> Novo workspace</MenuItem>}
              <div className="my-1 border-t border-line" />
              <MenuItem danger onClick={logout}><LogOut className="size-4" /> Sair</MenuItem>
            </>
          )}
        </Popover>
        <button onClick={onClose} className="rounded-md p-1.5 text-mute hover:bg-hover md:hidden"><X className="size-4" /></button>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        <button onClick={onSearch} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-dim hover:bg-hover hover:text-fg">
          <Search className="size-4" /> <span className="flex-1 text-left">Buscar</span>
          <kbd className="hidden rounded border border-line px-1 text-[10px] text-mute md:inline">Ctrl K</kbd>
        </button>
        <button onClick={onNew} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-dim hover:bg-hover hover:text-fg">
          <Plus className="size-4" /> <span className="flex-1 text-left">Nova issue</span>
          <kbd className="hidden rounded border border-line px-1 text-[10px] text-mute md:inline">C</kbd>
        </button>

        <div className="mb-1 mt-4 px-2 text-[11px] font-medium text-mute">Trabalho</div>
        {link(base, <LayoutGrid className="size-4" />, 'Issues', working ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-400"><span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" />{working}</span>
        ) : null)}
        {link(`${base}/analytics`, <BarChart3 className="size-4" />, 'Analytics')}

        {(can(me, 'agent.create', 'agent.update', 'agent.delete', 'skill.create', 'skill.update', 'skill.delete',
          'repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete')) && (
          <div className="mb-1 mt-4 px-2 text-[11px] font-medium text-mute">Configuração</div>
        )}
        {can(me, 'agent.create', 'agent.update', 'agent.delete') && link(`${base}/agentes`, <Bot className="size-4" />, 'Agentes')}
        {can(me, 'skill.create', 'skill.update', 'skill.delete') && link(`${base}/skills`, <BookOpen className="size-4" />, 'Skills')}
        {can(me, 'repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete') &&
          link(`${base}/workspace`, <FolderCog className="size-4" />, 'Workspace e repositórios')}

        {(can(me, 'user.create', 'user.update', 'user.delete', 'settings.manage') || me?.isOwner) && (
          <div className="mb-1 mt-4 px-2 text-[11px] font-medium text-mute">Administração</div>
        )}
        {can(me, 'user.create', 'user.update', 'user.delete') && link(`${base}/usuarios`, <Users className="size-4" />, 'Usuários')}
        {me?.isOwner && link(`${base}/permissoes`, <ShieldCheck className="size-4" />, 'Permissões')}
        {can(me, 'settings.manage', 'repo.create') && link(`${base}/servidor`, <Server className="size-4" />, 'Servidor')}
      </nav>

      <div className="space-y-0.5 border-t border-line p-2 safe-bottom">
        {link('/sobre', <CircleHelp className="size-4" />, 'Como funciona')}
        {link(`${base}/conta`, <UserRound className="size-4" />, 'Minha conta')}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo workspace">
        <CreateWorkspaceForm onDone={(w) => { setCreating(false); nav(`/w/${w.key}/workspace`); }} />
      </Modal>
    </>
  );
}
