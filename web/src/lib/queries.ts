import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Agent, Label, Member, ModelOption, Permission, Repo, Role, Rule, RuntimeModels, Skill, Stage, User, Workspace } from './types';
import { localizeStages, registerStages } from './constants';
import { t } from './i18n';

// retryOnMount: false — without a login, /me gives 401; another component that mounts
// must not redo the query (the "loading" again unmounted the screen in a loop).
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<User>('/me'), retry: false, retryOnMount: false, staleTime: 60_000 });
// The signed-in user's role permissions ('*' = owner, can do everything).
export const can = (u: User | undefined, ...perms: string[]) =>
  !!u && (u.permissions.includes('*') || perms.some((p) => u.permissions.includes(p)));
export const useCan = (...perms: string[]) => can(useMe().data, ...perms);

// Who sees each screen: its "view" or any permission to change it.
// With none, the screen leaves the menu; with only "view", it opens read-only.
export const SCREENS = {
  analytics: ['analytics.view'],
  analyticsGlobal: ['analytics.global'],
  workflow: ['workflow.view', 'workflow.manage'],
  workspace: ['workspace.view', 'repo.create', 'repo.update', 'repo.delete', 'member.manage', 'workspace.update', 'workspace.delete'],
  labels: ['label.view', 'label.create', 'label.update', 'label.delete'],
  agents: ['agent.view', 'agent.create', 'agent.update', 'agent.delete'],
  skills: ['skill.view', 'skill.create', 'skill.update', 'skill.delete'],
  users: ['user.view', 'user.create', 'user.update', 'user.delete']
} as const;
export const canSee = (u: User | undefined, screen: keyof typeof SCREENS) => can(u, ...SCREENS[screen]);
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
export const usePermissions = () => useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/permissions'), staleTime: Infinity });
export const useMembers = (ws?: string) =>
  useQuery({ queryKey: ['members', ws], queryFn: () => api.get<Member[]>(`/workspaces/${ws}/members`), enabled: !!ws });
export const useWorkspaces = () => useQuery({ queryKey: ['workspaces'], queryFn: () => api.get<Workspace[]>('/workspaces') });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: () => api.get<Agent[]>('/agents') });
export const useSkills = () => useQuery({ queryKey: ['skills'], queryFn: () => api.get<Skill[]>('/skills') });
export const useUsers = (enabled = true) => useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users'), enabled });
export const useRepos = (ws?: string) =>
  useQuery({ queryKey: ['repos', ws], queryFn: () => api.get<Repo[]>(`/workspaces/${ws}/repos`), enabled: !!ws });
export const useLabels = (ws?: string) =>
  useQuery({ queryKey: ['labels', ws], queryFn: () => api.get<Label[]>(`/workspaces/${ws}/labels`), enabled: !!ws });
export const useBranches = (repoId?: string | null) =>
  useQuery({
    queryKey: ['branches', repoId],
    queryFn: () => api.get<string[]>(`/repos/${repoId}/branches`),
    enabled: !!repoId,
    staleTime: 60_000,
    retry: false
  });

// Model catalog read from the CLIs on the server (it refreshes itself every 6 h).
export const useModels = () => useQuery({ queryKey: ['models'], queryFn: () => api.get<RuntimeModels[]>('/runtimes/models'), staleTime: 10 * 60_000 });

// The agent's model status against the catalog: ok, unknown or unsupported effort.
export function modelStatus(catalog: RuntimeModels[] | undefined, runtime: string, model: string, effort: string): { option?: ModelOption; warning?: string } {
  const rt = catalog?.find((c) => c.runtime === runtime);
  if (!rt?.installed || !rt.models.length) return {};
  const option = rt.models.find((m) => m.id === model);
  if (model && !option && !(runtime === 'claude' && model.startsWith('claude-'))) return { warning: t('"{0}" isn\'t in the {1} catalog', model, runtime === 'claude' ? t('Claude Code') : t('Codex')) };
  const efforts = option?.efforts ?? rt.efforts;
  if (effort && efforts.length && !efforts.includes(effort)) return { option, warning: t('effort "{0}" isn\'t accepted by this model', effort) };
  return { option };
}

// Etapas do workspace (sistema + personalizadas); alimentam o registro usado por statusOf.
export const useStages = (wsId: string) => useQuery({
  queryKey: ['stages', wsId],
  queryFn: async () => {
    const list = localizeStages(await api.get<Stage[]>(`/workspaces/${wsId}/stages`));
    registerStages(list);
    return list;
  },
  enabled: !!wsId,
  staleTime: 60_000
});
export const useRules = (wsId: string) => useQuery({ queryKey: ['rules', wsId], queryFn: () => api.get<Rule[]>(`/workspaces/${wsId}/rules`) });
