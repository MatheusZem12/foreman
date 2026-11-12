import { Suspense, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart3, Bot, Globe2, BookOpen, ChevronsUpDown, CircleHelp, FolderCog, Tags, LayoutGrid, LogOut, Menu, PanelLeft, Plus, Search, Settings, UserRound, Workflow, X
} from 'lucide-react';
import { Avatar, Modal, MenuItem, PageLoader, Popover } from './ui';
import { NewIssueModal } from './NewIssue';
import { SearchModal } from './SearchModal';
import { CreateWorkspaceForm } from '../pages/Onboarding';
import { can, canSee, useMe, useStages, useWorkspaces } from '../lib/queries';
import { useWorking } from '../lib/board';
import { useRealtime } from '../lib/realtime';
import { api } from '../lib/api';
import { LAST_WS } from '../lib/constants';
import type { Status, Workspace } from '../lib/types';
import { t } from '../lib/i18n';
import { PrefsQuick } from './Prefs';

interface Ctx {
  ws: Workspace;
  openNewIssue: (status?: Status) => void;
}
const WorkspaceCtx = createContext<Ctx>(null!);
export const useWs = () => useContext(WorkspaceCtx);

function isTyping(e: KeyboardEvent) {
  const tt = e.target as HTMLElement;
  return tt.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tt.tagName);
}

// On a desktop the menu can shrink to a rail of icons; the choice stays in this browser.
const RAIL = 'foreman.sidebar';
function readRail() {
  try {
    return localStorage.getItem(RAIL) === 'rail';
  } catch {
    return false;
  }
}

export function Layout() {
  const { key } = useParams();
  const { data: workspaces, isLoading } = useWorkspaces();
  const ws = workspaces?.find((w) => w.key === key?.toUpperCase());
  const [drawer, setDrawer] = useState(false);
  const [rail, setRail] = useState(readRail);
  const [newIssue, setNewIssue] = useState<{ status?: Status } | null>(null);
  const [search, setSearch] = useState(false);
  const loc = useLocation();

  useRealtime(ws?.id);
  const stages = useStages(ws?.id ?? '');
  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    if (ws) {
      try {
        localStorage.setItem(LAST_WS, ws.key);
      } catch {
        /* no storage */
      }
    }
  }, [ws]);
  const toggleRail = () => setRail((r) => {
    try {
      localStorage.setItem(RAIL, r ? 'full' : 'rail');
    } catch {
      /* no storage */
    }
    return !r;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      } else if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) {
        return;
      } else if (e.key === 'c') {
        e.preventDefault();
        setNewIssue({});
      } else if (e.key === '[') {
        e.preventDefault();
        toggleRail();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const ctx = useMemo(() => (ws ? { ws, openNewIssue: (status?: Status) => setNewIssue({ status }) } : null), [ws]);
  if (isLoading || (ws && stages.isPending)) return <PageLoader />;
  if (!ws || !ctx) return <Navigate to="/" replace />;

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <div className="flex h-full">
        {/* A fixed sidebar on a desktop, a drawer on a phone. */}
        <div className={clsx('fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden', drawer ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={() => setDrawer(false)} />
        <aside
          className={clsx(
            'fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[85vw] flex-col border-r border-line bg-panel transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:transition-none',
            rail ? 'md:w-[3.25rem]' : 'md:w-60',
            drawer ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <Sidebar ws={ws} workspaces={workspaces!} rail={rail} onRail={toggleRail} onSearch={() => setSearch(true)} onNew={() => setNewIssue({})} onClose={() => setDrawer(false)} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-1 border-b border-line px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden">
            <button onClick={() => setDrawer(true)} aria-label={t('Menu')} className="icon-btn"><Menu className="size-[18px]" /></button>
            <span className="min-w-0 flex-1 truncate px-1 font-semibold">{ws.name}</span>
            <button onClick={() => setSearch(true)} aria-label={t('Search')} className="icon-btn"><Search className="size-[18px]" /></button>
          </header>
          <main className="min-h-0 flex-1 overflow-hidden">
            {/* Each screen's code arrives on demand; the menu stays while it does. */}
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </main>
        </div>

        {/* A floating new-issue button on phones, only on the board: elsewhere it would sit on
            top of save buttons, comment boxes and the end of lists. */}
        {/^\/w\/[^/]+\/?$/.test(loc.pathname) && <button
          onClick={() => setNewIssue({})}
          className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 z-30 grid size-12 place-items-center rounded-full bg-accent text-snow shadow-pop transition-transform active:scale-95 md:hidden"
          aria-label={t('New issue')}
        >
          <Plus className="size-5" />
        </button>}
      </div>
      {newIssue && <NewIssueModal initialStatus={newIssue.status} onClose={() => setNewIssue(null)} />}
      {search && <SearchModal onClose={() => setSearch(false)} />}
    </WorkspaceCtx.Provider>
  );
}

function Sidebar({ ws, workspaces, rail, onRail, onSearch, onNew, onClose }: {
  ws: Workspace; workspaces: Workspace[]; rail: boolean; onRail: () => void; onSearch: () => void; onNew: () => void; onClose: () => void;
}) {
  const { data: me } = useMe();
  const working = useWorking(ws.id).data?.count ?? 0;
  const nav = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const base = `/w/${ws.key}`;
  // The rail only exists on a desktop: inside the phone's drawer the menu is always whole.
  const hide = rail && 'md:hidden';
  const row = clsx('flex h-8 items-center gap-2.5 rounded-lg px-2 text-dim transition-colors hover:bg-hover hover:text-fg coarse:h-10', rail && 'md:justify-center md:px-0');

  const logout = async () => {
    await api.post('/logout');
    qc.clear();
    nav('/login');
  };

  const link = (to: string, icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
    <NavLink to={to} end={to === base} title={rail ? label : undefined} className={({ isActive }) => clsx(row, 'relative', isActive && 'bg-hover text-fg')}>
      {icon} <span className={clsx('min-w-0 flex-1 truncate', hide)}>{label}</span> {extra}
    </NavLink>
  );
  const group = (label: string) => (
    <>
      <div className={clsx('label-caps mb-1 mt-5 px-2', hide)}>{label}</div>
      {rail && <div className="mx-2 my-2 hidden border-t border-line md:block" />}
    </>
  );

  return (
    <>
      <div className={clsx('flex h-12 shrink-0 items-center gap-1 px-2', rail && 'md:justify-center')}>
        <Popover
          className="w-64"
          trigger={() => (
            <button title={rail ? ws.name : undefined} className={clsx('flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 transition-colors hover:bg-hover', rail && 'md:flex-none')}>
              <WsBadge name={ws.name} />
              <span className={clsx('min-w-0 flex-1 truncate text-left font-semibold', hide)}>{ws.name}</span>
              <ChevronsUpDown className={clsx('size-3.5 shrink-0 text-mute', hide)} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="label-caps px-2.5 pb-1 pt-1.5">{t('Workspaces')}</div>
              {workspaces.map((w) => (
                <MenuItem key={w.id} selected={w.id === ws.id} onClick={() => { nav(`/w/${w.key}`); close(); }}>
                  <WsBadge name={w.name} muted={w.id !== ws.id} /> <span className="truncate">{w.name}</span>
                  <span className="ml-auto pl-2 font-mono text-[10px] text-mute">{w.key}</span>
                </MenuItem>
              ))}
              {can(me, 'workspace.create') && <>
                <div className="my-1 border-t border-line" />
                <MenuItem onClick={() => { setCreating(true); close(); }}><Plus className="size-4 text-mute" /> {t('New workspace')}</MenuItem>
              </>}
            </>
          )}
        </Popover>
        <button onClick={onRail} title={`${rail ? t('Expand menu') : t('Collapse menu')} · [`} aria-label={rail ? t('Expand menu') : t('Collapse menu')} className={clsx('icon-btn hidden md:grid', rail && 'md:hidden')}><PanelLeft className="size-4" /></button>
        <button onClick={onClose} aria-label={t('Close')} className="icon-btn md:hidden"><X className="size-4" /></button>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 pb-2">
        {rail && <button onClick={onRail} title={`${t('Expand menu')} · [`} aria-label={t('Expand menu')} className={clsx(row, 'hidden md:flex')}><PanelLeft className="size-4" /></button>}
        <button onClick={onSearch} title={rail ? t('Search') : undefined} className={row}>
          <Search className="size-4 shrink-0" /> <span className={clsx('flex-1 text-left', hide)}>{t('Search')}</span>
          <kbd className={clsx('kbd hidden md:inline', hide)}>{t('Ctrl K')}</kbd>
        </button>
        <button onClick={onNew} title={rail ? t('New issue') : undefined} className={row}>
          <Plus className="size-4 shrink-0" /> <span className={clsx('flex-1 text-left', hide)}>{t('New issue')}</span>
          <kbd className={clsx('kbd hidden md:inline', hide)}>{t('C')}</kbd>
        </button>

        {group(t('Work'))}
        {link(base, <LayoutGrid className="size-4 shrink-0" />, t('Issues'), working ? (
          <span className={clsx('flex items-center gap-1 text-[11px] tabular-nums text-amber-400', rail && 'md:absolute md:right-1 md:top-1')}>
            <span className="size-1.5 animate-pulse-soft rounded-full bg-amber-400" /><span className={clsx(hide)}>{working}</span>
          </span>
        ) : null)}
        {canSee(me, 'analytics') && link(`${base}/analytics`, <BarChart3 className="size-4 shrink-0" />, t('Analytics'))}
        {canSee(me, 'analyticsGlobal') && link(`${base}/analytics-overall`, <Globe2 className="size-4 shrink-0" />, t('Overall Analytics'))}

        {(canSee(me, 'workflow') || canSee(me, 'workspace') || canSee(me, 'labels')) && group(t('Workspace'))}
        {canSee(me, 'workflow') && link(`${base}/workflow`, <Workflow className="size-4 shrink-0" />, t('Workflow & automations'))}
        {canSee(me, 'workspace') && link(`${base}/workspace`, <FolderCog className="size-4 shrink-0" />, t('Repositories & people'))}
        {canSee(me, 'labels') && link(`${base}/labels`, <Tags className="size-4 shrink-0" />, t('Labels'))}

        {(canSee(me, 'agents') || canSee(me, 'skills')) && group(t('AI'))}
        {canSee(me, 'agents') && link(`${base}/agents`, <Bot className="size-4 shrink-0" />, t('Agents'))}
        {canSee(me, 'skills') && link(`${base}/skills`, <BookOpen className="size-4 shrink-0" />, t('Skills'))}

        {group(t('Settings'))}
        {link(`${base}/config`, <Settings className="size-4 shrink-0" />, t('General settings'))}
      </nav>

      {/* The person: account, help, theme, language and sign out. */}
      <div className="border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Popover
          block
          className="w-64"
          trigger={() => (
            <button title={rail ? me?.name : undefined} className={clsx('flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-hover', rail && 'md:justify-center md:px-0')}>
              <Avatar name={me?.name} size={24} />
              <span className={clsx('min-w-0 flex-1', hide)}>
                <span className="block truncate text-[13px] font-medium leading-tight">{me?.name}</span>
                <span className="block truncate text-[11px] leading-tight text-mute">{me?.isOwner ? t('owner') : me?.roleName}</span>
              </span>
            </button>
          )}
        >
          {(close) => (
            <>
              {me && (
                <div className="px-2.5 pb-2 pt-1.5">
                  <div className="truncate font-medium">{me.name}</div>
                  <div className="truncate text-xs text-mute">{me.email}</div>
                </div>
              )}
              <div className="mb-1 border-t border-line" />
              <MenuItem onClick={() => { nav(`${base}/config/account`); close(); }}><UserRound className="size-4 text-mute" /> {t('My account')}</MenuItem>
              <Link to="/about" onClick={close} className="flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-hover coarse:min-h-10"><CircleHelp className="size-4 text-mute" /> {t('How it works')}</Link>
              <div className="my-1 border-t border-line" />
              <PrefsQuick className="px-1 py-0.5" />
              <div className="my-1 border-t border-line" />
              <MenuItem danger onClick={logout}><LogOut className="size-4" /> {t('Sign out')}</MenuItem>
            </>
          )}
        </Popover>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title={t('New workspace')}>
        <CreateWorkspaceForm onDone={(w) => { setCreating(false); nav(`/w/${w.key}/workspace`); }} />
      </Modal>
    </>
  );
}

// The workspace's initial on a small tile.
export function WsBadge({ name, muted }: { name: string; muted?: boolean }) {
  return (
    <span className={clsx('grid size-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold uppercase', muted ? 'bg-white/[0.08] text-dim' : 'bg-accent text-snow')}>{name[0]}</span>
  );
}
