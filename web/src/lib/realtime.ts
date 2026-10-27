import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Comment, Issue, IssueDetail, Run, RunEvent } from './types';

type Event =
  | { type: 'issue'; data: Issue }
  | { type: 'issue_deleted'; data: { id: string } }
  | { type: 'run'; data: Run }
  | { type: 'run_event'; data: { issueId: string; event: RunEvent } }
  | { type: 'comment'; data: Comment };

function upsert<T extends { id: string | number }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

function apply(qc: QueryClient, ws: string, ev: Event) {
  switch (ev.type) {
    case 'issue':
      qc.setQueryData<Issue[]>(['issues', ws], (l) => upsert(l, ev.data));
      qc.setQueryData<IssueDetail>(['issue', ev.data.id], (d) => (d ? { ...d, issue: ev.data } : d));
      break;
    case 'issue_deleted':
      qc.setQueryData<Issue[]>(['issues', ws], (l) => l?.filter((i) => i.id !== ev.data.id));
      break;
    case 'run':
      qc.setQueryData<IssueDetail>(['issue', ev.data.issueId], (d) => (d ? { ...d, runs: upsert(d.runs, ev.data)! } : d));
      qc.invalidateQueries({ queryKey: ['analytics'] });
      break;
    case 'run_event':
      qc.setQueryData<RunEvent[]>(['events', ev.data.event.runId], (l) => (l ? upsert(l, ev.data.event) : l));
      break;
    case 'comment':
      qc.setQueryData<IssueDetail>(['issue', ev.data.issueId], (d) => (d ? { ...d, comments: upsert(d.comments, ev.data)! } : d));
      break;
  }
}

// Mantém o cache em dia com o que acontece no servidor (agentes rodando, outros usuários).
export function useRealtime(ws?: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ws) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource(`/api/workspaces/${ws}/events`);
      es.onmessage = (m) => {
        try {
          apply(qc, ws, JSON.parse(m.data));
        } catch {
          /* evento malformado: ignora */
        }
      };
      es.onerror = () => {
        es?.close();
        retry = setTimeout(() => {
          // Ao reconectar, recarrega o que pode ter mudado enquanto estava fora.
          qc.invalidateQueries({ queryKey: ['issues', ws] });
          qc.invalidateQueries({ queryKey: ['issue'] });
          connect();
        }, 3000);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, [ws, qc]);
}
