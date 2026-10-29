import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Comment, Issue, IssueDetail, Run, RunEvent } from './types';
import { removeIssue, upsertIssue } from './board';

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
      upsertIssue(qc, ws, ev.data);
      qc.setQueryData<IssueDetail>(['issue', ev.data.id], (d) => (d ? { ...d, issue: ev.data } : d));
      break;
    case 'issue_deleted':
      removeIssue(qc, ws, ev.data.id);
      break;
    case 'run':
      qc.setQueryData<IssueDetail>(['issue', ev.data.issueId], (d) => (d ? { ...d, runs: upsert(d.runs, ev.data)! } : d));
      qc.invalidateQueries({ queryKey: ['analytics'] });
      qc.invalidateQueries({ queryKey: ['working', ws] });
      break;
    case 'run_event':
      qc.setQueryData<RunEvent[]>(['events', ev.data.event.runId], (l) => (l ? upsert(l, ev.data.event) : l));
      break;
    case 'comment':
      qc.setQueryData<IssueDetail>(['issue', ev.data.issueId], (d) => (d ? { ...d, comments: upsert(d.comments, ev.data)! } : d));
      break;
  }
}

// Keeps the cache up to date with what happens on the server (agents running, other users).
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
          // On reconnecting, reloads what may have changed while it was away.
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
