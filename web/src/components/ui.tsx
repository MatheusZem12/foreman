import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X, Check, Loader2 } from 'lucide-react';
import { statusOf } from '../lib/constants';
import type { Status } from '../lib/types';

// ---------- botões e campos ----------

type BtnVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'success';

export function Button({
  variant = 'outline', size = 'md', className, loading, children, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-default',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent/85',
        variant === 'ghost' && 'text-dim hover:bg-hover hover:text-fg',
        variant === 'outline' && 'border border-line bg-card hover:bg-hover',
        variant === 'danger' && 'border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20',
        variant === 'success' && 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
        className
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-dim">
        {label} {hint && <span className="font-normal text-mute">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-left text-dim">
      <span className={clsx('relative h-4 w-7 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}>
        <span className={clsx('absolute top-0.5 size-3 rounded-full bg-white transition-all', checked ? 'left-3.5' : 'left-0.5')} />
      </span>
      {label}
    </button>
  );
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('size-4 animate-spin text-mute', className)} />;

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('py-10 text-center text-mute', className)}>{children}</div>;
}

// ---------- modal ----------

export function Modal({
  open, onClose, title, children, footer, wide
}: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx('flex max-h-[92dvh] w-full flex-col rounded-t-xl border border-line bg-panel shadow-2xl sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        {title && (
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="font-semibold">{title}</div>
            <button onClick={onClose} className="rounded p-1 text-mute hover:bg-hover hover:text-fg"><X className="size-4" /></button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 safe-bottom">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// ---------- popover / seletor ----------

export function Popover({
  trigger, children, align = 'left', className
}: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex">
      <div onClick={() => setOpen((o) => !o)} className="inline-flex">{trigger(open)}</div>
      {open && (
        <div
          className={clsx(
            'z-40 min-w-[200px] rounded-lg border border-line bg-panel p-1 shadow-2xl',
            // No celular vira uma "folha" presa embaixo da tela.
            'max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:max-h-[60dvh] max-sm:overflow-y-auto',
            'sm:absolute sm:top-full sm:mt-1 sm:max-h-80 sm:overflow-y-auto',
            align === 'right' ? 'sm:right-0' : 'sm:left-0',
            className
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, selected, danger }: { children: ReactNode; onClick: () => void; selected?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover', danger && 'text-red-400')}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {selected && <Check className="size-3.5 text-accent" />}
    </button>
  );
}

export function Chip({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={clsx('inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-dim hover:bg-hover hover:text-fg', className)}
    >
      {children}
    </button>
  );
}

// ---------- ícones de status e prioridade ----------

export function StatusIcon({ status, className }: { status: Status; className?: string }) {
  const { color } = statusOf(status);
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', className: clsx('shrink-0', className) };
  switch (status) {
    case 'backlog':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="2 2" /></svg>;
    case 'todo':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" /></svg>;
    case 'in_progress':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" /><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={color} /></svg>;
    case 'in_review':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" /><path d="M7 3.5a3.5 3.5 0 1 1-3.5 3.5H7z" fill={color} /></svg>;
    case 'blocked':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" /><path d="M3.2 10.8l7.6-7.6" stroke={color} strokeWidth="1.5" /></svg>;
    case 'done':
      return <svg {...common}><circle cx="7" cy="7" r="6.25" fill={color} /><path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#111" strokeWidth="1.6" /></svg>;
    case 'cancelled':
      return <svg {...common}><circle cx="7" cy="7" r="6.25" fill={color} /><path d="M5 5l4 4M9 5l-4 4" stroke="#111" strokeWidth="1.5" /></svg>;
  }
}

export function PriorityIcon({ priority, className }: { priority: number; className?: string }) {
  if (priority === 1) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" className={clsx('shrink-0', className)}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#f97316" />
        <path d="M7 3.8v4M7 9.6v.6" stroke="#111" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (priority === 0) {
    return <svg width="14" height="14" viewBox="0 0 14 14" className={clsx('shrink-0', className)}><path d="M3 7h1.5M6.25 7h1.5M9.5 7H11" stroke="rgb(var(--mute))" strokeWidth="1.5" /></svg>;
  }
  const bars = 5 - priority; // alta=3, média=2, baixa=1
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={clsx('shrink-0', className)}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.5" height={3 + i * 3} rx="0.6" fill={i < bars ? 'rgb(var(--dim))' : 'rgb(var(--line))'} />
      ))}
    </svg>
  );
}

export function Avatar({ name, emoji, size = 18 }: { name?: string; emoji?: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-hover text-[10px] font-semibold uppercase text-dim"
      style={{ width: size, height: size, fontSize: emoji ? size * 0.62 : size * 0.48 }}
    >
      {emoji || (name || '?').slice(0, 1)}
    </span>
  );
}

// ---------- toasts ----------

type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto max-w-sm rounded-lg border bg-panel px-3.5 py-2.5 shadow-2xl',
              t.kind === 'error' ? 'border-red-500/40 text-red-300' : t.kind === 'success' ? 'border-emerald-500/40' : 'border-line'
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useConfirm() {
  return (message: string) => window.confirm(message);
}
