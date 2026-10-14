import { Building2, Home, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Public shape ──────────────────────────────────────────────────────────
// `TimeLocation` is the superset of location values the UI knows how to
// render. The DB column (`TimeEntry.location`) stays a free string, so
// `normalizeTimeLocation` below is what every surface uses to resolve a
// raw string back into one of these three — unknown values default to
// `'office'`, which preserves historical behaviour (home vs. office was
// the only pre-existing distinction).
export type TimeLocation = 'office' | 'home' | 'site';

export interface LocationToggleProps {
  value: TimeLocation;
  onChange: (next: TimeLocation) => void;
  /** `sm` for compact rows (tight toolbars), `md` for forms (default). */
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
}

// ─── Shared helpers (icon / label / emoji / normaliser) ────────────────────
// Exported so entry-display rows, compact rows, lists, etc. can resolve a
// location without re-implementing the mapping.
export const TIME_LOCATION_LABELS: Record<TimeLocation, string> = {
  home: 'Home',
  office: 'Office',
  site: 'Site',
};

export const TIME_LOCATION_EMOJI: Record<TimeLocation, string> = {
  home: '🏠',
  office: '🏢',
  site: '📍',
};

// Any raw string from the backend becomes a `TimeLocation`. The default
// (and anything unknown) falls back to `'office'` so legacy rows that
// predate this control keep their current visual.
export function normalizeTimeLocation(v: string | null | undefined): TimeLocation {
  if (v === 'home' || v === 'site') return v;
  return 'office';
}

// 1-line icon component rendering the matching lucide icon for `value`.
// Kept here so every surface imports a single resolver — swapping Site's
// icon later is a one-file change.
export function TimeLocationIcon({ value, className }: { value: TimeLocation; className?: string }) {
  if (value === 'home') return <Home className={className} aria-hidden="true" />;
  if (value === 'site') return <MapPin className={className} aria-hidden="true" />;
  return <Building2 className={className} aria-hidden="true" />;
}

// ─── Component ─────────────────────────────────────────────────────────────
// 3-way segmented control (Home / Office / Site). Follows the existing
// weekly-timesheet selected-state treatment (`bg-blue-100 text-blue-700`,
// `dark:bg-blue-500/15 dark:text-blue-400`) so visually it reads as a
// drop-in replacement for the old inline Home/Office pair.
const OPTIONS: ReadonlyArray<{ value: TimeLocation; label: string }> = [
  { value: 'home', label: TIME_LOCATION_LABELS.home },
  { value: 'office', label: TIME_LOCATION_LABELS.office },
  { value: 'site', label: TIME_LOCATION_LABELS.site },
];

export function LocationToggle({
  value,
  onChange,
  size = 'md',
  className,
  disabled = false,
}: LocationToggleProps) {
  const isSm = size === 'sm';
  // Icon size tracks the segmented-control size — 12px for `sm` (tight
  // toolbars) and 14px for `md` (forms). Matches the historical weekly
  // timesheet pair which rendered 14px icons.
  const iconCls = isSm ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <div
      role="radiogroup"
      aria-label="Work location"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 p-0.5',
        disabled && 'opacity-50 pointer-events-none',
        className,
      )}
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.label}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md font-semibold transition-colors',
              isSm ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]',
              selected
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/50',
            )}
          >
            <TimeLocationIcon value={opt.value} className={iconCls} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
