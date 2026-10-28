import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Issue } from './types';

// O quadro nunca carrega todas as issues. O servidor devolve as primeiras
// PAGE_FIRST de cada etapa (cada uma na ordem escolhida para ela) e o total de
// cada etapa; rolar uma coluna busca mais PAGE_MORE só daquela etapa. Busca e
// filtros também vão para o servidor. O cache fica em ['issues', ws, …] e o
// tempo real (realtime.ts) atualiza todas as variações dele.

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
    placeholderData: (prev) => prev // trocar o filtro não pisca o quadro vazio
  });
}

// Uma página de uma etapa. replace = recarrega a etapa do zero (troca de ordem).
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

// Atualiza a issue em todos os quadros em cache (todas as combinações de filtro).
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

// A mesma ordem do servidor, para o que chega pelo tempo real cair no lugar certo.
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

// Busca rápida (Ctrl+K): no servidor, as mais recentes que batem.
export const searchIssues = (ws: string, q: string) =>
  api.get<Issue[]>(`/workspaces/${ws}/issues?${params({ q, who: '', label: '' }, { sort: 'updated', limit: 20 })}`);

export const useWorking = (ws: string) =>
  useQuery({ queryKey: ['working', ws], queryFn: () => api.get<{ count: number }>(`/workspaces/${ws}/working`), staleTime: 30_000 });
