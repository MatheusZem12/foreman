import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Agent, Issue, Label, Member, Permission, Repo, Role, Skill, User, Workspace } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<User>('/me'), retry: false, staleTime: 60_000 });
// Permissões do perfil do usuário logado ('*' = dono, pode tudo).
export const can = (u: User | undefined, ...perms: string[]) =>
  !!u && (u.permissions.includes('*') || perms.some((p) => u.permissions.includes(p)));
export const useCan = (...perms: string[]) => can(useMe().data, ...perms);
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
