// Etapa: as do sistema ou o id de uma etapa personalizada do workspace.
export type Status = 'backlog' | 'todo' | 'in_progress' | 'waiting' | 'in_review' | 'blocked' | 'done' | 'cancelled' | (string & {});
export interface Who { roles?: string[]; users?: string[] }
export type LockField = 'title' | 'description' | 'priority' | 'labels' | 'agent' | 'repos' | 'assignee';
export type Requirement = 'agent' | 'assignee' | 'description' | 'changes';
export interface StagePolicy {
  enter: Who; act: Who; locked?: LockField[]; requires?: Requirement[]; wip?: number;
  approvals?: number; approveTo?: string; approvers: Who; responsible: Who; readOnly?: boolean;
}
export interface Stage { id: string; name: string; color: string; position: number; system: boolean; policy: StagePolicy; parallel?: boolean }
export type RuleAction = 'notify' | 'webhook' | 'move' | 'run_agent' | 'open_pr' | 'merge' | 'script'
  | 'set_agent' | 'set_priority' | 'add_label' | 'assign' | 'comment';
export type RuleTrigger = 'enter' | 'leave' | 'stale' | 'created' | 'commented' | 'run_finished' | 'cost_over' | 'assigned' | 'priority_changed';
export interface RuleConditions {
  priorities?: number[]; labels?: string[]; agents?: string[]; outcomes?: string[]; hours?: number; cost?: number; actorRoles?: string[];
}
export interface RuleConfig {
  to?: string; roles?: string[]; users?: string[]; message?: string; url?: string; agentId?: string; request?: string;
  base?: string; draft?: boolean; script?: string; onFail?: string; priority?: number; labelId?: string; mode?: string;
}
export interface Rule {
  id: string; workspaceId: string; stage: string; action: RuleAction; config: RuleConfig; enabled: boolean; position: number;
  trigger: RuleTrigger; conditions: RuleConditions; name: string;
}
export interface WorkflowWarning { where: string; message: string; stageId?: string; ruleId?: string }

export interface User {
  id: string; email: string; name: string; about: string; emailNotifications: boolean; createdAt: string;
  isOwner: boolean; roleId: string | null; roleName: string; permissions: string[]; workspaceIds?: string[];
}
export interface Permission { id: string; group: string; label: string }
export interface Role { id: string; name: string; permissions: string[]; users: number }
export interface Member extends User { linked: boolean }
export interface Workspace { id: string; name: string; key: string; createdAt: string; intakeStage?: string }
export interface FileEntry { path: string; content: string }
export interface Repo {
  id: string; workspaceId: string; name: string; url: string; defaultBranch: string; targetBranch: string;
  description: string;
}
export interface Skill { id: string; slug: string; name: string; description: string; content: string; files: FileEntry[]; always: boolean; updatedAt: string }
export interface Agent {
  id: string; name: string; avatar: string; runtime: 'claude' | 'codex'; model: string; effort: string;
  maxBudgetUsd: number | null; instructions: string; skillIds: string[]; extraArgs: string;
}
export interface Label { id: string; workspaceId: string; name: string; color: string }
export interface Issue {
  id: string; workspaceId: string; number: number; title: string; description: string; status: Status; priority: number;
  position: number; agentId: string | null; branch: string; allRepos: boolean; repos: IssueRepo[];
  labelIds: string[]; skillIds: string[]; summary: string; createdBy: string | null;
  createdAt: string; updatedAt: string; activeRun: string | null; costUsd: number;
  assigneeId: string | null; stageSince: string; approvals: string[];
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
  outcome: '' | 'done' | 'waiting' | 'incomplete'; outcomeNote: string;
}
export interface RunEvent { id: number; runId: string; kind: string; body: string; createdAt: string }
export interface Comment {
  id: string; issueId: string; userId: string | null; agentId: string | null; runId: string | null;
  kind: 'comment' | 'agent' | 'system'; body: string; createdAt: string;
}
// O que a pessoa pode fazer nesta issue agora (perfil + política da etapa).
export interface Caps {
  edit: boolean; move: boolean; comment: boolean; priority: boolean; labels: boolean; agent: boolean; repos: boolean;
  assign: boolean; run: boolean; approve: boolean; merge: boolean; delete: boolean; approvals: number; approveTo: string; reason?: string;
}
export interface IssueDetail { issue: Issue; runs: Run[]; comments: Comment[]; caps: Caps }
export interface RepoDiff { repoId: string; name: string; stat: string; patch: string; pending: boolean; merged: string }
export interface RepoMerge { repoId: string; name: string; target: string; conflict?: boolean; files?: string[]; sha?: string }
export interface GitInfo { version: string; home: string; sshKey?: string; credentialHelper: string; user: string; gh: boolean }
export interface Totals { costUsd: number; inputTokens: number; cachedTokens: number; outputTokens: number; seconds: number; runs: number; failed: number }
export interface Analytics {
  totals: Totals;
  issues: { created: number; resolved: number; open: number; avgResolveHours: number; medResolveHours: number };
  daily: (Totals & { day: string })[];
  monthly: { month: string; created: number; resolved: number; costUsd: number; runs: number }[];
  status: { status: Status; count: number }[];
  agents: (Totals & { agentId: string | null; agentName: string })[];
  models: (Totals & { runtime: string; model: string })[];
  users: { userId: string | null; name: string; runs: number; costUsd: number }[];
  top: { id: string; ref: string; title: string; status: Status; costUsd: number; runs: number }[];
  priorities: { priority: number; issues: number; runs: number; costUsd: number; avgSeconds: number }[];
  creators: { userId: string | null; name: string; runs: number; costUsd: number }[];
  stageTimes: { stage: string; name: string; passes: number; avgHours: number; medHours: number }[];
  people: { userId: string; name: string; created: number; openAssigned: number; resolved: number; resolveHours: number; comments: number; approvals: number; runs: number; costUsd: number; replyHours: number }[];
}
export interface Runtime { runtime: string; bin: string; installed: boolean; version: string }
export interface ModelOption { id: string; label: string; description?: string; group: 'alias' | 'model' | 'used'; efforts?: string[]; defaultEffort?: string }
export interface RuntimeModels { runtime: 'claude' | 'codex'; installed: boolean; models: ModelOption[]; efforts: string[]; source: string; fetchedAt: string; error?: string }
export interface EmailSettings {
  enabled: boolean; host: string; port: number; security: 'starttls' | 'tls' | 'none'; username: string; password?: string;
  from: string; fromName: string; appUrl: string; notifyRules?: number;
  hasPassword?: boolean; status?: { lastSentAt: string | null; lastError: string; lastErrorAt: string | null };
}
