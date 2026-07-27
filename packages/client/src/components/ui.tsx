/** Small shared UI pieces used across screens. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { LANGS, useI18n, dictionaryFor, type Lang } from '../i18n/index.js';

// ------------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

interface ToastValue {
  push(text: string, kind?: Toast['kind']): void;
}

const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-2), { id, text, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'info' ? '' : ` toast-${t.kind}`}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

// -------------------------------------------------------------------- modal

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
  dismissable = true,
}: {
  open: boolean;
  onClose(): void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  dismissable?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose, dismissable]);

  if (!open) return null;
  return (
    <div
      className="overlay"
      onPointerDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {title ? <h2 className="modal-title">{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ switch

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: ReactNode;
  hint?: ReactNode;
}): ReactNode {
  return (
    <label className="switch row-between" style={{ width: '100%' }}>
      <span className="grow">
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{label}</span>
        {hint ? <span className="field-hint" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

// ------------------------------------------------------------ language pill

export function LanguageSwitch({ compact = false }: { compact?: boolean }): ReactNode {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {LANGS.map((code: Lang) => (
        <button
          key={code}
          type="button"
          aria-pressed={lang === code}
          onClick={() => setLang(code)}
          title={dictionaryFor(code).meta.name}
        >
          {compact ? dictionaryFor(code).meta.short.slice(0, 2) : dictionaryFor(code).meta.short}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- brand

export function BrandMark({ size = 30 }: { size?: number }): ReactNode {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="9" fill="url(#wr-grad)" />
      <rect x="6.5" y="7" width="9" height="5" rx="2.5" fill="white" opacity="0.95" />
      <rect x="17" y="7" width="8.5" height="5" rx="2.5" fill="white" opacity="0.6" />
      <rect x="6.5" y="14" width="5" height="11" rx="2.5" fill="white" opacity="0.6" />
      <circle cx="19.2" cy="19.5" r="5.6" fill="white" />
      <circle cx="17.6" cy="17.9" r="1.9" fill="url(#wr-grad)" opacity="0.35" />
      <defs>
        <linearGradient id="wr-grad" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#2081ef" />
          <stop offset="1" stopColor="#7444e8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ------------------------------------------------------------------- tiles

export function Tile({
  icon,
  title,
  sub,
  tint,
  hero = false,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  tint?: string;
  hero?: boolean;
  onClick(): void;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className={`tile${hero ? ' tile-hero' : ''}`}
      style={tint ? ({ '--tile-tint': tint } as React.CSSProperties) : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="tile-icon">{icon}</span>
      <span className="tile-body">
        <span className="tile-title">{title}</span>
        {sub ? <span className="tile-sub">{sub}</span> : null}
      </span>
      <span className="tile-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ helpers

export function formatClock(ms: number): string {
  if (ms <= 0) return '0:00';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatRelative(ts: number, lang: Lang): string {
  const diff = Date.now() - ts;
  const rtf = new Intl.RelativeTimeFormat(lang === 'hy' ? 'hy-AM' : lang, {
    numeric: 'auto',
  });
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return rtf.format(-Math.max(1, Math.round(diff / minute)), 'minute');
  if (diff < day) return rtf.format(-Math.round(diff / hour), 'hour');
  if (diff < 30 * day) return rtf.format(-Math.round(diff / day), 'day');
  return new Intl.DateTimeFormat(lang === 'hy' ? 'hy-AM' : lang, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(ts);
}

export function BackButton({ onClick }: { onClick(): void }): ReactNode {
  const { t } = useI18n();
  return (
    <button type="button" className="btn btn-ghost btn-icon" onClick={onClick} aria-label={t.nav.back}>
      ‹
    </button>
  );
}
