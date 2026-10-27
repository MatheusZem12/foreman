import type { Status } from './types';

export const STATUSES: { id: Status; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: '#8b8b94' },
  { id: 'todo', label: 'A fazer', color: '#d4d4d8' },
  { id: 'in_progress', label: 'Em andamento', color: '#f5b83d' },
  { id: 'in_review', label: 'Em revisão', color: '#4ade80' },
  { id: 'blocked', label: 'Bloqueada', color: '#f87171' },
  { id: 'done', label: 'Concluída', color: '#60a5fa' },
  { id: 'cancelled', label: 'Cancelada', color: '#71717a' }
];
export const BOARD_STATUSES: Status[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'];
export const statusOf = (id: Status) => STATUSES.find((s) => s.id === id)!;

export const PRIORITIES = [
  { id: 0, label: 'Sem prioridade' },
  { id: 1, label: 'Urgente' },
  { id: 2, label: 'Alta' },
  { id: 3, label: 'Média' },
  { id: 4, label: 'Baixa' }
];

export const LABEL_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b'];


export const LAST_WS = 'mx.lastWorkspace';
export const LAST_AGENT = 'mx.lastAgent';
