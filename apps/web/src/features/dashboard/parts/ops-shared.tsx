import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared building blocks for the Operations dashboard tabs.
 *
 * Extracted from operations-dashboard.tsx so BIM Leader, Active
 * Projects, Executive Review and the existing Risk/Team panes all
 * share one visual language and one error/loading treatment. Adding a
 * new metric to the ops screen should mean touching ONE component
 * here, not five copies scattered across five files.
 */

// ─── Colour + status helpers (used across tabs) ────────────────────────

export const OPS_STATUS_CFG: Record<
  string,
  { label: string; dot: string; bg: string; border: string; text: string }
> = {
  critical: { label: 'Critical', dot: 'bg-red-600',     bg: 'bg-red-50',     border: 'border-red-200',     text: 'text-red-700' },
  high:     { label: 'At Risk',  dot: 'bg-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-200',   text: 'text-amber-700' },
  medium:   { label: 'Monitor',  dot: 'bg-blue-600',    bg: 'bg-blue-50',    border: 'border-blue-200',    text: 'text-blue-700' },
  ok:       { label: 'OK',       dot: 'bg-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700' },
};

export const OPS_PRI_COLORS: Record<string, string> = {
  critical: 'bg-red-600',
  high:     'bg-amber-600',
  medium:   'bg-blue-600',
  low:      'bg-slate-400',
};

// ─── Presentational primitives ────────────────────────────────────────

export function OpsAvatar({ firstName, lastName, size = 24 }: { firstName?: string | null; lastName?: string | null; size?: number }) {
  const initials = `${(firstName ?? '')[0] ?? ''}${(lastName ?? '')[0] ?? ''}`.toUpperCase();
  return (
    <div
      className="rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0 font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.35 }}
    >
      {initials}
    </div>
  );
}

export function OpsLoadBar({ used, capacity }: { used: number; capacity: number }) {
  const pct = capacity > 0 ? Math.round((used / capacity) * 100) : 0;
  const color =
    pct > 110 ? 'bg-red-600'
    : pct > 100 ? 'bg-red-500'
    : pct > 90 ? 'bg-amber-500'
    : pct > 60 ? 'bg-blue-500'
    : 'bg-emerald-500';
  const textColor =
    pct > 110 ? 'text-red-600'
    : pct > 100 ? 'text-red-500'
    : pct > 90 ? 'text-amber-500'
    : pct > 60 ? 'text-blue-500'
    : 'text-emerald-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-[4px] bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden min-w-[40px]">
        <div className={cn('h-full rounded-full transition-all duration-300', color)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={cn('font-mono tabular-nums text-[11px] font-bold min-w-[30px] text-right', textColor)}>{pct}%</span>
    </div>
  );
}

export function OpsChevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <ChevronRight
      className={cn('text-slate-400 dark:text-slate-500 transition-transform duration-150 shrink-0', open && 'rotate-90')}
      style={{ width: size, height: size }}
    />
  );
}

// ─── Fetch-state feedback ─────────────────────────────────────────────
//
// The BM operational-effectiveness checklist explicitly calls out
// "Real loading, empty, and error+retry states (no infinite spinner,
// no silent empty on fetch failure)". Every ops query surfaces its
// failure through this banner and offers a one-click Retry.

export function OpsErrorBanner({
  title,
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-[14px] border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3',
        className,
      )}
    >
      <div className="mt-0.5 shrink-0 text-red-600 dark:text-red-400">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-red-900 dark:text-red-100">
          {title ?? 'Could not load this section'}
        </p>
        {message && (
          <p className="text-[12px] text-red-700 dark:text-red-300 mt-0.5 break-words">{message}</p>
        )}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry loading this section"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800 bg-white dark:bg-red-950/60 hover:border-red-500 hover:text-red-700 dark:hover:text-red-200 text-red-700 dark:text-red-200 text-[12px] font-semibold px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:border-blue-500"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Convert an unknown error (usually an axios error) into a short
 * human-readable message. Kept in the shared module so every ops
 * tab renders the same phrasing.
 */
export function opsErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  const anyErr = err as any;
  const msg =
    anyErr?.response?.data?.message ??
    anyErr?.response?.data?.error ??
    anyErr?.message ??
    String(err);
  if (Array.isArray(msg)) return msg.join('; ');
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
}
