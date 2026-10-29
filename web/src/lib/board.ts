import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Issue } from './types';

// The board never loads every issue. The server returns the first PAGE_FIRST of each
// stage (each in the order chosen for it) and each stage's total; scrolling a column
// fetches PAGE_MORE more of that stage only. Search and filters go to the server too.
// The cache lives in ['issues', ws, …] and real time (realtime.ts) updates every
// variation of it.

export const PAGE_FIRST = 30;
export const PAGE_MORE = 40;

export type BoardSort = 'manual' | 'newest' | 'oldest' | 'updated' | 'priority';
export interface BoardFilters { q: string; who: string; label: string }
export interface BoardData { issues: Issue[]; counts: Record<string, number>; working: number }

export const boardKey = (ws: string, f: BoardFilters) => ['issues', ws, 'board', f.q, f.who, f.label];

const params = (f: BoardFilters, extra: Record<string, string | number>) => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.who && f.who !== 'all') p.set('who', f.who);
  if (f.label) p.set('label', f.label);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
};

export function useBoard(ws: string, f: BoardFilters, sorts: Record<string, BoardSort>) {
  return useQuery({
    queryKey: boardKey(ws, f),
    queryFn: () => api.get<BoardData>(`/workspaces/${ws}/board?${params(f, { limit: PAGE_FIRST, sorts: JSON.stringify(sorts) })}`),
    placeholderData: (prev) => prev // changing the filter doesn't flash an empty board
  });
}

// One page of a stage. replace = reloads the stage from scratch (order change).
export async function loadStage(qc: QueryClient, ws: string, f: BoardFilters, stage: string, sort: BoardSort, offset: number, limit: number, replace = false) {
  const page = await api.get<Issue[]>(`/workspaces/${ws}/issues?${params(f, { stage, sort, offset, limit })}`);
  qc.setQueryData<BoardData>(boardKey(ws, f), (d) => {
    if (!d) return d;
    const keep = replace ? d.issues.filter((i) => i.status !== stage) : d.issues;
    const seen = new Set(keep.map((i) => i.id));
    return { ...d, issues: [...keep, ...page.filter((i) => !seen.has(i.id))] };
  });
  return page.length;
}

// Updates the issue on every cached board (every filter combination).
export function upsertIssue(qc: QueryClient, ws: string, issue: Issue) {
  qc.setQueriesData<BoardData>({ queryKey: ['issues', ws] }, (d) => {
    if (!d?.issues) return d;
    const old = d.issues.find((i) => i.id === issue.id);
    const counts = { ...d.counts };
    if (!old) counts[issue.status] = (counts[issue.status] ?? 0) + 1;
    else if (old.status !== issue.status) {
      counts[old.status] = Math.max(0, (counts[old.status] ?? 1) - 1);
      counts[issue.status] = (counts[issue.status] ?? 0) + 1;
    }
    const working = d.working + (issue.activeRun ? 1 : 0) - (old?.activeRun ? 1 : 0);
    return { issues: old ? d.issues.map((i) => (i.id === issue.id ? issue : i)) : [...d.issues, issue], counts, working: Math.max(0, working) };
  });
}

export function removeIssue(qc: QueryClient, ws: string, id: string) {
  qc.setQueriesData<BoardData>({ queryKey: ['issues', ws] }, (d) => {
    const old = d?.issues?.find((i) => i.id === id);
    if (!d || !old) return d;
    return { ...d, issues: d.issues.filter((i) => i.id !== id), counts: { ...d.counts, [old.status]: Math.max(0, (d.counts[old.status] ?? 1) - 1) } };
  });
}

// The same order as the server, so what arrives in real time lands in the right place.
export function sortIssues(list: Issue[], sort: BoardSort) {
  const copy = list.slice();
  const num = (a: Issue, b: Issue) => b.number - a.number;
  switch (sort) {
    case 'priority': return copy.sort((a, b) => (a.priority || 9) - (b.priority || 9) || b.updatedAt.localeCompare(a.updatedAt) || num(a, b));
    case 'updated': return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || num(a, b));
    case 'newest': return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || num(a, b));
    case 'oldest': return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
    default: return copy.sort((a, b) => a.position - b.position || num(a, b));
  }
}

// Quick search (Ctrl+K): on the server, the most recent matches.
export const searchIssues = (ws: string, q: string) =>
  api.get<Issue[]>(`/workspaces/${ws}/issues?${params({ q, who: '', label: '' }, { sort: 'updated', limit: 20 })}`);

export const useWorking = (ws: string) =>
  useQuery({ queryKey: ['working', ws], queryFn: () => api.get<{ count: number }>(`/workspaces/${ws}/working`), staleTime: 30_000 });
