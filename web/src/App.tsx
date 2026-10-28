import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider, Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Board } from './pages/Board';
import { IssuePage } from './pages/IssuePage';
import { SettingsPage } from './pages/Settings';
import { WorkflowPage } from './pages/Workflow';
import { WorkspaceSettings } from './pages/WorkspaceSettings';
import { LabelsPage } from './pages/Labels';
import { AgentsPage } from './pages/Agents';
import { SkillsPage } from './pages/Skills';
import { Landing } from './pages/Landing';
import { Onboarding } from './pages/Onboarding';
import { SCREENS, can, useMe, useWorkspaces } from './lib/queries';
import { LAST_WS } from './lib/constants';
import { t } from './lib/i18n';

// Analytics carrega os gráficos (Recharts) só quando a tela é aberta.
const AnalyticsPage = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.AnalyticsPage })));

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } }
});

function Home() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const { data: me } = useMe();
  if (isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (!workspaces?.length) return can(me, 'workspace.create') ? <Navigate to="/novo" replace /> : <NoWorkspace />;
  let last = '';
  try {
    last = localStorage.getItem(LAST_WS) || '';
  } catch {
    /* sem storage */
  }
  const ws = workspaces.find((w) => w.key === last) ?? workspaces[0];
  return <Navigate to={`/w/${ws.key}`} replace />;
}

// Usuário sem vínculo: alguém com member.manage precisa adicioná-lo a um workspace.
function NoWorkspace() {
  const { data: me } = useMe();
  return (
    <div className="grid min-h-full place-items-center p-4">
      <div className="max-w-sm space-y-3 rounded-xl border border-line bg-panel p-6 text-center">
        <img src="/icon.svg" className="mx-auto size-8" alt="" />
        <p className="font-medium">{t('Olá,')} {me?.name}!</p>
        <p className="text-dim">{t('Você ainda não foi adicionado a nenhum workspace. Peça ao administrador para vincular você.')}</p>
        <button onClick={async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; }} className="text-xs text-mute hover:text-fg">{t('Sair')}</button>
      </div>
    </div>
  );
}

// Só renderiza para quem tem alguma das permissões (owner = só o dono).
function Need({ perms, owner, children }: { perms?: string[]; owner?: boolean; children: React.ReactNode }) {
  const { data: me } = useMe();
  const ok = owner ? !!me?.isOwner : can(me, ...(perms ?? []));
  if (me && !ok) return <Navigate to=".." replace />;
  return <>{children}</>;
}

function Authed({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading, error } = useMe();
  if (isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (error || !me) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// "/": quem está logado vai para o board; quem não está vê a landing.
function Root() {
  const { data: me, isPending, isError } = useMe();
  if (isPending && !isError) return <div className="grid h-full place-items-center"><Spinner /></div>;
  return me ? <Home /> : <Landing />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Root />} />
            <Route path="/sobre" element={<Landing />} />
            <Route path="/novo" element={<Authed><Need perms={['workspace.create']}><Onboarding /></Need></Authed>} />
            <Route path="/w/:key" element={<Authed><Layout /></Authed>}>
              <Route index element={<Board />} />
              <Route path="issues/:ref" element={<IssuePage />} />
              <Route path="analytics" element={<Need perms={[...SCREENS.analytics]}><Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}><AnalyticsPage /></Suspense></Need>} />
              <Route path="analytics-geral" element={<Need perms={[...SCREENS.analyticsGlobal]}><Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}><AnalyticsPage global /></Suspense></Need>} />
              <Route path="config" element={<SettingsPage />} />
              <Route path="config/:tab" element={<SettingsPage />} />
              <Route path="fluxo" element={<Need perms={[...SCREENS.fluxo]}><WorkflowPage /></Need>} />
              <Route path="workspace" element={<Need perms={[...SCREENS.workspace]}><WorkspaceSettings /></Need>} />
              <Route path="labels" element={<Need perms={[...SCREENS.labels]}><LabelsPage /></Need>} />
              <Route path="agentes" element={<Need perms={[...SCREENS.agentes]}><AgentsPage /></Need>} />
              <Route path="skills" element={<Need perms={[...SCREENS.skills]}><SkillsPage /></Need>} />
              {/* Endereços antigos das telas gerais levam para a aba certa de Configurações gerais. */}
              {['usuarios', 'permissoes', 'servidor', 'conta'].map((tt) => (
                <Route key={tt} path={tt} element={<Navigate to={`../config/${tt}`} replace />} />
              ))}
              {['config/fluxo', 'config/workspace', 'config/agentes', 'config/skills'].map((tt) => (
                <Route key={tt} path={tt} element={<Navigate to={`../${tt.slice(7)}`} replace />} />
              ))}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

