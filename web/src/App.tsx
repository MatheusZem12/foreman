import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider, Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Board } from './pages/Board';
import { IssuePage } from './pages/IssuePage';
import { AnalyticsPage } from './pages/Analytics';
import { AgentsPage } from './pages/Agents';
import { SkillsPage } from './pages/Skills';
import { WorkspaceSettings } from './pages/WorkspaceSettings';
import { AccountPage, ServerPage, UsersPage } from './pages/Account';
import { RolesPage } from './pages/Roles';
import { Landing } from './pages/Landing';
import { Onboarding } from './pages/Onboarding';
import { can, useMe, useWorkspaces } from './lib/queries';
import { LAST_WS } from './lib/constants';

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
        <p className="font-medium">Olá, {me?.name}!</p>
        <p className="text-dim">Você ainda não foi adicionado a nenhum workspace. Peça ao administrador para vincular você.</p>
        <button onClick={async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; }} className="text-xs text-mute hover:text-fg">Sair</button>
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
  const { data: me, isLoading } = useMe();
  if (isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
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
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="agentes" element={<Need perms={['agent.create', 'agent.update', 'agent.delete']}><AgentsPage /></Need>} />
              <Route path="skills" element={<Need perms={['skill.create', 'skill.update', 'skill.delete']}><SkillsPage /></Need>} />
              <Route path="workspace" element={<Need perms={['repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete']}><WorkspaceSettings /></Need>} />
              <Route path="usuarios" element={<Need perms={['user.create', 'user.update', 'user.delete']}><UsersPage /></Need>} />
              <Route path="permissoes" element={<Need owner><RolesPage /></Need>} />
              <Route path="servidor" element={<Need perms={['settings.manage', 'repo.create']}><ServerPage /></Need>} />
              <Route path="conta" element={<AccountPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

