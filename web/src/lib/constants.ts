import type { Status } from './types';
import { t } from './i18n';

export interface StageInfo { id: Status; label: string; color: string; system: boolean; parallel?: boolean }

// Etapas do sistema; as personalizadas do workspace entram via registerStages
// (chamado quando /stages carrega). STATUSES é um "live binding": quem importa
// sempre vê a lista atual.
const SYSTEM_STAGES: StageInfo[] = [
  { id: 'backlog', label: t('Backlog'), color: '#8b8b94', system: true },
  { id: 'todo', label: t('A fazer'), color: '#d4d4d8', system: true },
  { id: 'in_progress', label: t('Em andamento'), color: '#f5b83d', system: true },
  { id: 'waiting', label: t('Aguardando você'), color: '#fb923c', system: true },
  { id: 'in_review', label: t('Em revisão'), color: '#4ade80', system: true },
  { id: 'blocked', label: t('Bloqueada'), color: '#f87171', system: true },
  { id: 'done', label: t('Concluída'), color: '#60a5fa', system: true },
  { id: 'cancelled', label: t('Cancelada'), color: '#71717a', system: true }
];
export let STATUSES: StageInfo[] = SYSTEM_STAGES;
// As etapas do sistema vêm do servidor com o nome em português; com o nome
// original (não renomeadas), mostram a tradução.
export function localizeStages<T extends { system: boolean; name: string }>(list: T[]): T[] {
  return list.map((s) => (s.system ? { ...s, name: t(s.name) } : s));
}
export function registerStages(list: { id: string; name: string; color: string; system: boolean; parallel?: boolean }[]) {
  STATUSES = list.map((s) => ({ id: s.id as Status, label: s.name, color: s.color, system: s.system, parallel: s.parallel }));
}

// Agrupa etapas em paralelo (marcadas como "ao lado da anterior") com a anterior:
// cada grupo é uma coluna no quadro e um degrau no mapa do fluxo.
export function stageGroups<T extends { id: string; parallel?: boolean }>(list: T[]): T[][] {
  const out: T[][] = [];
  for (const s of list) {
    if (s.parallel && out.length) out[out.length - 1].push(s);
    else out.push([s]);
  }
  return out;
}
export const isSystemStage = (id: string) => SYSTEM_STAGES.some((s) => s.id === id);
export const statusOf = (id: Status): StageInfo => STATUSES.find((s) => s.id === id) ?? SYSTEM_STAGES.find((s) => s.id === id) ?? { id, label: t('Etapa removida'), color: '#71717a', system: false };

export const PRIORITIES = [
  { id: 0, label: t('Sem prioridade') },
  { id: 1, label: t('Urgente') },
  { id: 2, label: t('Alta') },
  { id: 3, label: t('Média') },
  { id: 4, label: t('Baixa') }
];

export const LABEL_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b'];


export const LAST_WS = 'mx.lastWorkspace';
export const LAST_AGENT = 'mx.lastAgent';
