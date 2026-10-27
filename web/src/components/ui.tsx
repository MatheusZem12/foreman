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
        'relative inline-flex select-none items-center justify-center gap-2 rounded-[10px] font-medium whitespace-nowrap transition-all duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
        size === 'sm' ? 'h-7 rounded-lg px-2.5 text-xs' : 'h-9 px-4 text-[13px]',
        variant === 'primary' && 'bg-gradient-to-b from-[#8f80ff] to-accent text-white shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25),0_0_0_1px_rgb(var(--accent)/0.6),0_6px_16px_-6px_rgb(var(--accent)/0.7)] hover:brightness-110 hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.3),0_0_0_1px_rgb(var(--accent)/0.8),0_8px_22px_-6px_rgb(var(--accent)/0.85)]',
        variant === 'ghost' && 'text-dim hover:bg-white/[0.06] hover:text-fg',
        variant === 'outline' && 'bg-white/[0.04] text-fg shadow-[inset_0_1px_0_0_rgb(255_255_255/0.05),0_0_0_1px_rgb(255_255_255/0.09)] hover:bg-white/[0.07] hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.06),0_0_0_1px_rgb(255_255_255/0.16)]',
        variant === 'danger' && 'bg-red-500/10 text-red-300 shadow-[0_0_0_1px_rgb(239_68_68/0.3)] hover:bg-red-500/[0.18] hover:text-red-200',
        variant === 'success' && 'bg-emerald-500/10 text-emerald-300 shadow-[0_0_0_1px_rgb(16_185_129/0.3)] hover:bg-emerald-500/[0.18]',
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
      <span className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-accent shadow-[0_0_12px_-2px_rgb(var(--accent)/0.7)]' : 'bg-white/10 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]')}>
        <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)] transition-all duration-200', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label}
    </button>
  );
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('size-4 animate-spin text-mute', className)} />;

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('py-10 text-center text-mute', className)}>{children}</div>;
}

// Estado vazio com ícone, título, explicação e ação.
export function EmptyState({ icon: Icon, title, children, action, className }: {
  icon: React.ComponentType<{ className?: string }>; title: string; children?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-14 text-center', className)}>
      <div className="relative mb-4">
        <div className="absolute inset-0 rounded-2xl bg-accent/30 blur-xl" />
        <div className="relative grid size-12 place-items-center rounded-2xl border border-white/10 bg-gradient-to-b from-card to-panel">
          <Icon className="size-5 text-accent" />
        </div>
      </div>
      <div className="font-medium text-fg">{title}</div>
      {children && <p className="mt-1 max-w-sm text-sm text-mute">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Cabeçalho padrão das páginas.
export function PageHeader({ icon: Icon, title, description, actions }: {
  icon?: React.ComponentType<{ className?: string }>; title: string; description?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start gap-3">
      {Icon && (
        <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-b from-card to-panel">
          <Icon className="size-[18px] text-accent" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-mute">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
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
    <div className="fixed inset-0 z-50 flex animate-[fade_.15s_ease-out] items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx('flex max-h-[92dvh] w-full animate-[pop_.18s_ease-out] flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-panel shadow-pop sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        {title && (
          <div className="flex items-center justify-between gap-3 px-6 pb-3 pt-5">
            <div className="text-base font-semibold tracking-tight">{title}</div>
            <button onClick={onClose} aria-label="Fechar" className="-mr-1.5 grid size-8 place-items-center rounded-lg text-mute transition hover:bg-white/[0.06] hover:text-fg"><X className="size-4" /></button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2.5 border-t border-white/[0.06] bg-black/20 px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

// ---------- popover / seletor ----------

export function Popover({
  trigger, children, align = 'left', className, block
}: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string; block?: boolean }) {
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
    <div ref={ref} className={clsx('relative', block ? 'flex w-full' : 'inline-flex')}>
      <div onClick={() => setOpen((o) => !o)} className={block ? 'flex w-full' : 'inline-flex'}>{trigger(open)}</div>
      {open && (
        <div
          className={clsx(
            'z-40 min-w-[210px] animate-[pop_.12s_ease-out] rounded-xl border border-white/10 bg-panel/95 p-1 shadow-pop backdrop-blur-xl',
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
      className={clsx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.06]', danger && 'text-red-400')}
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
      className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/[0.02] px-2.5 text-xs text-dim transition hover:border-white/15 hover:bg-hover hover:text-fg', className)}
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
    case 'waiting':
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" /><path d="M5.6 4.8v4.4M8.4 4.8v4.4" stroke={color} strokeWidth="1.5" strokeLinecap="round" /></svg>;
    default:
      return <svg {...common}><circle cx="7" cy="7" r="5.5" fill="none" stroke={color} strokeWidth="1.5" /><circle cx="7" cy="7" r="2.2" fill={color} /></svg>;
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
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-white/15 to-white/5 text-[10px] font-semibold uppercase text-fg ring-1 ring-white/10"
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
              'pointer-events-auto flex max-w-sm animate-[pop_.18s_ease-out] items-start gap-2.5 rounded-xl border border-white/10 bg-panel/95 px-3.5 py-2.5 shadow-pop backdrop-blur-xl'
            )}
          >
            <span className={clsx('mt-1 size-2 shrink-0 rounded-full', t.kind === 'error' ? 'bg-red-400' : t.kind === 'success' ? 'bg-emerald-400' : 'bg-accent')} />
            <span className={t.kind === 'error' ? 'text-red-200' : ''}>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useConfirm() {
  return (message: string) => window.confirm(message);
}
