import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, Pencil, Plus, Search, Tags, Trash2 } from 'lucide-react';
import { useWs } from '../components/Layout';
import { Button, EmptyState, Field, Modal, PageHeader, Segmented, useToast, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { LABEL_COLORS } from '../lib/constants';
import { useCan, useLabels } from '../lib/queries';
import type { Label } from '../lib/types';
import { t } from '../lib/i18n';

// The workspace's labels: what each one is, how many issues use it and a shortcut to the
// filtered board. View, create, edit and delete are separate permissions.
export function LabelsPage() {
  const ask = useConfirm();
  const { ws } = useWs();
  const { data: labels = [], isLoading } = useLabels(ws.id);
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<'name' | 'used'>('used');
  const [editing, setEditing] = useState<Partial<Label> | null>(null);
  const canCreate = useCan('label.create');
  const canUpdate = useCan('label.update');
  const canDelete = useCan('label.delete');
  const qc = useQueryClient();
  const toast = useToast();

  const list = useMemo(() => {
    const tt = q.trim().toLowerCase();
    const l = labels.filter((x) => !tt || x.name.toLowerCase().includes(tt));
    return order === 'name' ? l.sort((a, b) => a.name.localeCompare(b.name)) : l.sort((a, b) => (b.issues ?? 0) - (a.issues ?? 0) || a.name.localeCompare(b.name));
  }, [labels, q, order]);
  const maxUsed = Math.max(1, ...labels.map((l) => l.issues ?? 0));

  const remove = async (l: Label) => {
    if (!(await ask({ title: t('Delete the label "{0}"?', l.name), message: l.issues ? t('It\'s removed from {0} issue(s).', l.issues) : undefined, confirmText: t('Delete'), danger: true }))) return;
    try {
      await api.del(`/labels/${l.id}`);
      qc.invalidateQueries({ queryKey: ['labels', ws.id] });
      qc.invalidateQueries({ queryKey: ['issues', ws.id] });
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="page">
        <PageHeader icon={Tags} title={t('Labels')}
          description={t('Tags to group this workspace\'s issues (e.g. bug, customer, front end). Use them to filter the board and in workflow rules.')}
          actions={canCreate && <Button variant="primary" onClick={() => setEditing({ color: LABEL_COLORS[labels.length % LABEL_COLORS.length] })}><Plus className="size-4" /> {t('New label')}</Button>} />

        {labels.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search labels…')} aria-label={t('Search labels…')} className="field-input h-8 py-1 pl-8" />
            </div>
            <Segmented className="ml-auto" items={[{ id: 'used', label: t('Most used') }, { id: 'name', label: t('Name') }]} value={order} onChange={setOrder} />
          </div>
        )}

        {!isLoading && !labels.length && (
          <EmptyState icon={Tags} title={t('No labels yet')}>{t('Create labels like “bug”, “customer” or “front end” to filter the board and fire rules (e.g. an issue with the customer label becomes urgent).')}</EmptyState>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {list.map((l) => (
            <div key={l.id} className="surface flex flex-col gap-3 p-4">
              <div className="flex items-start gap-3">
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: l.color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{l.name}</div>
                  <div className="text-xs text-mute">{t('{0} open · {1} total', l.open ?? 0, l.issues ?? 0)}</div>
                </div>
                <div className="-mr-1.5 -mt-1.5 flex shrink-0">
                  {canUpdate && <button title={t('Edit')} onClick={() => setEditing(l)} className="icon-btn"><Pencil className="size-3.5" /></button>}
                  {canDelete && <button title={t('Delete')} onClick={() => remove(l)} className="icon-btn icon-btn-danger"><Trash2 className="size-3.5" /></button>}
                </div>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full" style={{ width: `${((l.issues ?? 0) / maxUsed) * 100}%`, background: l.color }} />
              </div>
              <Link to={`/w/${ws.key}/issues?label=${l.id}`} className="inline-flex items-center gap-1 self-start text-xs text-mute hover:text-accent">
                {t('View on the board')} <ArrowUpRight className="size-3" />
              </Link>
            </div>
          ))}
        </div>
        {labels.length > 0 && !list.length && <p className="py-10 text-center text-mute">{t('Nothing found.')}</p>}
      </div>
      {editing && <LabelModal label={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const COLORS = [...LABEL_COLORS, '#14b8a6', '#f97316', '#84cc16', '#0ea5e9', '#d946ef', '#78716c'];

function LabelModal({ label, onClose }: { label: Partial<Label>; onClose: () => void }) {
  const { ws } = useWs();
  const [l, setL] = useState(label);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const save = async () => {
    setBusy(true);
    try {
      if (l.id) await api.put(`/labels/${l.id}`, { name: l.name, color: l.color });
      else await api.post(`/workspaces/${ws.id}/labels`, { name: l.name, color: l.color });
      qc.invalidateQueries({ queryKey: ['labels', ws.id] });
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={l.id ? t('Edit label') : t('New label')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('Save')}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-4">
        <Field label={t('Name')}><input autoFocus className="field-input" value={l.name ?? ''} onChange={(e) => setL({ ...l, name: e.target.value })} placeholder={t('E.g. bug, customer, front end')} /></Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-dim">{t('Color')}</span>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setL({ ...l, color: c })} style={{ background: c }}
                className={clsx('size-7 rounded-full transition hover:scale-110', l.color === c && 'ring-2 ring-fg/80 ring-offset-2 ring-offset-panel')} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-mute">
          {t('Preview:')}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-fg">
            <span className="size-2 rounded-full" style={{ background: l.color }} /> {l.name || t('label')}
          </span>
        </div>
      </form>
    </Modal>
  );
}
