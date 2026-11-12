import { lazy, Suspense, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfirmProvider, PageLoader, ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Board } from './pages/Board';
import { Onboarding } from './pages/Onboarding';
import { SCREENS, can, useMe, useWorkspaces } from './lib/queries';
import { LAST_WS } from './lib/constants';
import { t } from './lib/i18n';

// The board opens with the app. Every other screen is its own file, downloaded when it
// is first opened: the first load brings only what the board needs (no charts, no
// markdown, no workflow editor, no landing page).
const issuePage = () => import('./pages/IssuePage');
const IssuePage = lazy(() => issuePage().then((m) => ({ default: m.IssuePage })));
const AnalyticsPage = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.AnalyticsPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));
const WorkflowPage = lazy(() => import('./pages/Workflow').then((m) => ({ default: m.WorkflowPage })));
const WorkspaceSettings = lazy(() => import('./pages/WorkspaceSettings').then((m) => ({ default: m.WorkspaceSettings })));
const LabelsPage = lazy(() => import('./pages/Labels').then((m) => ({ default: m.LabelsPage })));
const AgentsPage = lazy(() => import('./pages/Agents').then((m) => ({ default: m.AgentsPage })));
const SkillsPage = lazy(() => import('./pages/Skills').then((m) => ({ default: m.SkillsPage })));
const Landing = lazy(() => import('./pages/Landing').then((m) => ({ default: m.Landing })));

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } }
});

function Home() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const { data: me } = useMe();
  if (isLoading) return <PageLoader />;
  if (!workspaces?.length) return can(me, 'workspace.create') ? <Navigate to="/new" replace /> : <NoWorkspace />;
  let last = '';
  try {
    last = localStorage.getItem(LAST_WS) || '';
  } catch {
    /* no storage */
  }
  const ws = workspaces.find((w) => w.key === last) ?? workspaces[0];
  return <Navigate to={`/w/${ws.key}`} replace />;
}

// A user without a link: someone with member.manage has to add them to a workspace.
function NoWorkspace() {
  const { data: me } = useMe();
  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="surface max-w-sm space-y-3 p-6 text-center">
        <img src="/icon.svg" className="mx-auto size-8" alt="" />
        <p className="font-medium">{t('Hi,')} {me?.name}!</p>
        <p className="text-dim">{t('You haven\'t been added to any workspace yet. Ask an administrator to add you.')}</p>
        <button onClick={async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; }} className="text-xs text-mute hover:text-fg">{t('Sign out')}</button>
      </div>
    </div>
  );
}

// Only renders for whoever has one of the permissions (owner = the owner only).
function Need({ perms, owner, children }: { perms?: string[]; owner?: boolean; children: React.ReactNode }) {
  const { data: me } = useMe();
  const ok = owner ? !!me?.isOwner : can(me, ...(perms ?? []));
  if (me && !ok) return <Navigate to=".." replace />;
  return <>{children}</>;
}

function Authed({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading, error } = useMe();
  // Signed in: while the browser is idle, fetch the issue page's code, so that opening
  // a card from the board is instant.
  useEffect(() => {
    if (!me) return;
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1500));
    const id = idle(() => { issuePage().catch(() => { /* offline: it loads when opened */ }); });
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(id);
  }, [me]);
  if (isLoading) return <PageLoader />;
  if (error || !me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// "/": whoever is signed in goes to the board; whoever isn't sees the landing page.
function Root() {
  const { data: me, isPending, isError } = useMe();
  if (isPending && !isError) return <PageLoader />;
  return me ? <Home /> : <Landing />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
      <ConfirmProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Root />} />
            <Route path="/about" element={<Landing />} />
            <Route path="/new" element={<Authed><Need perms={['workspace.create']}><Onboarding /></Need></Authed>} />
            <Route path="/w/:key" element={<Authed><Layout /></Authed>}>
              <Route index element={<Board />} />
              <Route path="issues/:ref" element={<IssuePage />} />
              <Route path="analytics" element={<Need perms={[...SCREENS.analytics]}><AnalyticsPage /></Need>} />
              <Route path="analytics-overall" element={<Need perms={[...SCREENS.analyticsGlobal]}><AnalyticsPage global /></Need>} />
              <Route path="config" element={<SettingsPage />} />
              <Route path="config/:tab" element={<SettingsPage />} />
              <Route path="workflow" element={<Need perms={[...SCREENS.workflow]}><WorkflowPage /></Need>} />
              <Route path="workspace" element={<Need perms={[...SCREENS.workspace]}><WorkspaceSettings /></Need>} />
              <Route path="labels" element={<Need perms={[...SCREENS.labels]}><LabelsPage /></Need>} />
              <Route path="agents" element={<Need perms={[...SCREENS.agents]}><AgentsPage /></Need>} />
              <Route path="skills" element={<Need perms={[...SCREENS.skills]}><SkillsPage /></Need>} />
              {/* Old addresses of the general screens lead to the right tab of General settings. */}
              {['users', 'permissions', 'server', 'account'].map((tt) => (
                <Route key={tt} path={tt} element={<Navigate to={`../config/${tt}`} replace />} />
              ))}
              {['config/workflow', 'config/workspace', 'config/agents', 'config/skills'].map((tt) => (
                <Route key={tt} path={tt} element={<Navigate to={`../${tt.slice(7)}`} replace />} />
              ))}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

