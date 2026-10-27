export type Status = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';

export interface User {
  id: string; email: string; name: string; about: string; emailNotifications: boolean; createdAt: string;
  isOwner: boolean; roleId: string | null; roleName: string; permissions: string[]; workspaceIds?: string[];
}
export interface Permission { id: string; group: string; label: string }
export interface Role { id: string; name: string; permissions: string[]; users: number }
export interface Member extends User { linked: boolean }
export interface Workspace { id: string; name: string; key: string; createdAt: string }
export interface FileEntry { path: string; content: string }
export interface Repo {
  id: string; workspaceId: string; name: string; url: string; defaultBranch: string; targetBranch: string;
  protectedBranches: string[]; setupScript: string; envFiles: FileEntry[]; instructions: string; description: string;
}
export interface Skill { id: string; slug: string; name: string; description: string; content: string; files: FileEntry[]; always: boolean; updatedAt: string }
export interface Agent {
  id: string; name: string; avatar: string; runtime: 'claude' | 'codex'; model: string; effort: string;
  maxBudgetUsd: number | null; permission: 'full' | 'edits'; instructions: string; skillIds: string[]; extraArgs: string;
}
export interface Label { id: string; workspaceId: string; name: string; color: string }
export interface Issue {
  id: string; workspaceId: string; number: number; title: string; description: string; status: Status; priority: number;
  position: number; agentId: string | null; branch: string; allRepos: boolean; repos: IssueRepo[];
  labelIds: string[]; skillIds: string[]; summary: string; createdBy: string | null;
  createdAt: string; updatedAt: string; activeRun: string | null; costUsd: number;
}
export interface IssueRepo {
  repoId: string; name: string; baseBranch: string; targetBranch: string;
  changed: boolean; conflict: boolean; mergedInto: string; mergedSha: string;
}
export interface Run {
  id: string; issueId: string; workspaceId: string; agentId: string | null; agentName: string; runtime: string; model: string;
  kind: 'initial' | 'followup' | 'conflict'; request: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  error: string; costUsd: number; inputTokens: number; cachedTokens: number; outputTokens: number; commitSha: string;
  createdBy: string | null; createdAt: string; startedAt: string | null; endedAt: string | null;
}
export interface RunEvent { id: number; runId: string; kind: string; body: string; createdAt: string }
export interface Comment {
  id: string; issueId: string; userId: string | null; agentId: string | null; runId: string | null;
  kind: 'comment' | 'agent' | 'system'; body: string; createdAt: string;
}
export interface IssueDetail { issue: Issue; runs: Run[]; comments: Comment[] }
export interface RepoDiff { repoId: string; name: string; stat: string; patch: string; pending: boolean; merged: string }
export interface RepoMerge { repoId: string; name: string; target: string; conflict?: boolean; files?: string[]; sha?: string }
export interface GitInfo { version: string; home: string; sshKey?: string; credentialHelper: string; user: string; gh: boolean }
export interface Totals { costUsd: number; inputTokens: number; cachedTokens: number; outputTokens: number; seconds: number; runs: number; failed: number }
export interface Analytics { totals: Totals; daily: (Totals & { day: string })[]; agents: (Totals & { agentId: string | null; agentName: string })[] }
export interface Runtime { runtime: string; bin: string; installed: boolean; version: string }
export interface EmailSettings {
  enabled: boolean; host: string; port: number; security: 'starttls' | 'tls' | 'none'; username: string; password?: string;
  from: string; fromName: string; appUrl: string;
  hasPassword?: boolean; status?: { lastSentAt: string | null; lastError: string; lastErrorAt: string | null };
}
