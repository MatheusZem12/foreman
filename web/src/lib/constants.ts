import type { Status } from './types';
import { t } from './i18n';

export interface StageInfo { id: Status; label: string; color: string; parallel?: boolean; closes?: string }

// The default workflow's stages, only until the workspace loads its own through
// registerStages (called when /stages loads). STATUSES is a "live binding": whoever imports
// it always sees the current list.
const SYSTEM_STAGES: StageInfo[] = [
  { id: 'backlog', label: t('Backlog'), color: '#8b8b94' },
  { id: 'todo', label: t('To do'), color: '#d4d4d8' },
  { id: 'in_progress', label: t('In progress'), color: '#f5b83d' },
  { id: 'waiting', label: t('Waiting for you'), color: '#fb923c' },
  { id: 'in_review', label: t('In review'), color: '#4ade80' },
  { id: 'blocked', label: t('Blocked'), color: '#f87171' },
  { id: 'done', label: t('Done'), color: '#60a5fa' },
  { id: 'cancelled', label: t('Cancelled'), color: '#71717a' }
];
export let STATUSES: StageInfo[] = SYSTEM_STAGES;
// The system stages come from the server with their English default name; while they keep
// it (not renamed), they show the translation.
export function localizeStages<T extends { id: string; name: string }>(list: T[]): T[] {
  return list.map((s) => (DEFAULT_NAMES[s.id] === s.name ? { ...s, name: t(s.name) } : s));
}
// The names the default workflow is born with (in English, in the database).
const DEFAULT_NAMES: Record<string, string> = {
  backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', waiting: 'Waiting for you',
  in_review: 'In review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled'
};
export function registerStages(list: { id: string; name: string; color: string; parallel?: boolean; policy?: { close?: string } }[]) {
  STATUSES = list.map((s) => ({ id: s.id as Status, label: s.name, color: s.color, parallel: s.parallel, closes: s.policy?.close || '' }));
}

// Groups parallel stages (marked "next to the previous one") with the previous one: each
// group is a column on the board and a step on the workflow map.
export function stageGroups<T extends { id: string; parallel?: boolean }>(list: T[]): T[][] {
  const out: T[][] = [];
  for (const s of list) {
    if (s.parallel && out.length) out[out.length - 1].push(s);
    else out.push([s]);
  }
  return out;
}
export const statusOf = (id: Status): StageInfo => STATUSES.find((s) => s.id === id) ?? SYSTEM_STAGES.find((s) => s.id === id) ?? { id, label: t('Removed stage'), color: '#71717a' };

export const PRIORITIES = [
  { id: 0, label: t('No priority') },
  { id: 1, label: t('Urgent') },
  { id: 2, label: t('High') },
  { id: 3, label: t('Medium') },
  { id: 4, label: t('Low') }
];

export const LABEL_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b'];


export const LAST_WS = 'foreman.lastWorkspace';
export const LAST_AGENT = 'foreman.lastAgent';
