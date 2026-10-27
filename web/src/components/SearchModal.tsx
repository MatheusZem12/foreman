import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { createPortal } from 'react-dom';
import { StatusIcon } from './ui';
import { useWs } from './Layout';
import { useIssues } from '../lib/queries';

export function SearchModal({ onClose }: { onClose: () => void }) {
  const { ws } = useWs();
  const { data: issues = [] } = useIssues(ws.id);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t
      ? issues.filter((i) => `${ws.key}-${i.number} ${i.title} ${i.description}`.toLowerCase().includes(t))
      : [...issues].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list.slice(0, 30);
  }, [q, issues, ws.key]);
  const open = (n: number) => {
    nav(`/w/${ws.key}/issues/${ws.key}-${n}`);
    onClose();
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-3 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-mute" />
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === 'Enter' && results[sel]) open(results[sel].number);
            }}
            placeholder="Buscar issues…"
            className="h-11 flex-1"
          />
        </div>
        <div className="max-h-[55vh] overflow-y-auto p-1">
          {results.map((i, idx) => (
            <button
              key={i.id}
              onMouseEnter={() => setSel(idx)}
              onClick={() => open(i.number)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left ${idx === sel ? 'bg-hover' : ''}`}
            >
              <StatusIcon status={i.status} />
              <span className="w-16 shrink-0 font-mono text-xs text-mute">{ws.key}-{i.number}</span>
              <span className="truncate">{i.title}</span>
            </button>
          ))}
          {!results.length && <div className="p-6 text-center text-mute">Nada encontrado.</div>}
        </div>
      </div>
    </div>,
    document.body
  );
}
