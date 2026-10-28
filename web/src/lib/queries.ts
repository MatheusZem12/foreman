import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Agent, Issue, Label, Member, ModelOption, Permission, Repo, Role, Rule, RuntimeModels, Skill, Stage, User, Workspace } from './types';
import { registerStages } from './constants';

// retryOnMount: false — sem login, /me dá 401; outro componente que monte não
// pode refazer a consulta (o "carregando" de novo desmontava a tela num loop).
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<User>('/me'), retry: false, retryOnMount: false, staleTime: 60_000 });
// Permissões do perfil do usuário logado ('*' = dono, pode tudo).
export const can = (u: User | undefined, ...perms: string[]) =>
  !!u && (u.permissions.includes('*') || perms.some((p) => u.permissions.includes(p)));
export const useCan = (...perms: string[]) => can(useMe().data, ...perms);

// Quem vê cada tela: o "ver" dela ou qualquer permissão de mexer nela.
// Sem nenhuma, a tela some do menu; só com o "ver", abre em modo leitura.
export const SCREENS = {
  analytics: ['analytics.view'],
  fluxo: ['workflow.view', 'workflow.manage'],
  workspace: ['workspace.view', 'repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete', 'label.manage'],
  agentes: ['agent.view', 'agent.create', 'agent.update', 'agent.delete'],
  skills: ['skill.view', 'skill.create', 'skill.update', 'skill.delete'],
  usuarios: ['user.view', 'user.create', 'user.update', 'user.delete']
} as const;
export const canSee = (u: User | undefined, screen: keyof typeof SCREENS) => can(u, ...SCREENS[screen]);
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
export const usePermissions = () => useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/permissions'), staleTime: Infinity });
export const useMembers = (ws?: string) =>
  useQuery({ queryKey: ['members', ws], queryFn: () => api.get<Member[]>(`/workspaces/${ws}/members`), enabled: !!ws });
export const useWorkspaces = () => useQuery({ queryKey: ['workspaces'], queryFn: () => api.get<Workspace[]>('/workspaces') });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: () => api.get<Agent[]>('/agents') });
export const useSkills = () => useQuery({ queryKey: ['skills'], queryFn: () => api.get<Skill[]>('/skills') });
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
export const useRepos = (ws?: string) =>
  useQuery({ queryKey: ['repos', ws], queryFn: () => api.get<Repo[]>(`/workspaces/${ws}/repos`), enabled: !!ws });
export const useLabels = (ws?: string) =>
  useQuery({ queryKey: ['labels', ws], queryFn: () => api.get<Label[]>(`/workspaces/${ws}/labels`), enabled: !!ws });
export const useIssues = (ws?: string) =>
  useQuery({ queryKey: ['issues', ws], queryFn: () => api.get<Issue[]>(`/workspaces/${ws}/issues`), enabled: !!ws });
export const useBranches = (repoId?: string | null) =>
  useQuery({
    queryKey: ['branches', repoId],
    queryFn: () => api.get<string[]>(`/repos/${repoId}/branches`),
    enabled: !!repoId,
    staleTime: 60_000,
    retry: false
  });

// Catálogo de modelos lido dos CLIs no servidor (atualiza sozinho a cada 6 h).
export const useModels = () => useQuery({ queryKey: ['models'], queryFn: () => api.get<RuntimeModels[]>('/runtimes/models'), staleTime: 10 * 60_000 });

// Situação do modelo do agente frente ao catálogo: ok, desconhecido ou esforço não suportado.
export function modelStatus(catalog: RuntimeModels[] | undefined, runtime: string, model: string, effort: string): { option?: ModelOption; warning?: string } {
  const rt = catalog?.find((c) => c.runtime === runtime);
  if (!rt?.installed || !rt.models.length) return {};
  const option = rt.models.find((m) => m.id === model);
  if (model && !option && !(runtime === 'claude' && model.startsWith('claude-'))) return { warning: `"${model}" não está no catálogo do ${runtime === 'claude' ? 'Claude Code' : 'Codex'}` };
  const efforts = option?.efforts ?? rt.efforts;
  if (effort && efforts.length && !efforts.includes(effort)) return { option, warning: `esforço "${effort}" não é aceito por este modelo` };
  return { option };
}

// Etapas do workspace (sistema + personalizadas); alimentam o registro usado por statusOf.
export const useStages = (wsId: string) => useQuery({
  queryKey: ['stages', wsId],
  queryFn: async () => {
    const list = await api.get<Stage[]>(`/workspaces/${wsId}/stages`);
    registerStages(list);
    return list;
  },
  enabled: !!wsId,
  staleTime: 60_000
});
export const useRules = (wsId: string) => useQuery({ queryKey: ['rules', wsId], queryFn: () => api.get<Rule[]>(`/workspaces/${wsId}/rules`) });
