import type { Status } from './types';

export interface StageInfo { id: Status; label: string; color: string; system: boolean }

// Etapas do sistema; as personalizadas do workspace entram via registerStages
// (chamado quando /stages carrega). STATUSES é um "live binding": quem importa
// sempre vê a lista atual.
const SYSTEM_STAGES: StageInfo[] = [
  { id: 'backlog', label: 'Backlog', color: '#8b8b94', system: true },
  { id: 'todo', label: 'A fazer', color: '#d4d4d8', system: true },
  { id: 'in_progress', label: 'Em andamento', color: '#f5b83d', system: true },
  { id: 'waiting', label: 'Aguardando você', color: '#fb923c', system: true },
  { id: 'in_review', label: 'Em revisão', color: '#4ade80', system: true },
  { id: 'blocked', label: 'Bloqueada', color: '#f87171', system: true },
  { id: 'done', label: 'Concluída', color: '#60a5fa', system: true },
  { id: 'cancelled', label: 'Cancelada', color: '#71717a', system: true }
];
export let STATUSES: StageInfo[] = SYSTEM_STAGES;
export function registerStages(list: { id: string; name: string; color: string; system: boolean }[]) {
  STATUSES = list.map((s) => ({ id: s.id as Status, label: s.name, color: s.color, system: s.system }));
}
export const isSystemStage = (id: string) => SYSTEM_STAGES.some((s) => s.id === id);
export const statusOf = (id: Status): StageInfo => STATUSES.find((s) => s.id === id) ?? SYSTEM_STAGES.find((s) => s.id === id) ?? { id, label: 'Etapa removida', color: '#71717a', system: false };

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
