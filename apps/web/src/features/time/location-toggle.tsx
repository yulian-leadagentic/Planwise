import { Building2, Calendar, Home, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Public shape ──────────────────────────────────────────────────────────
// `TimeLocation` is the superset of location values the UI knows how to
// render. The DB column (`TimeEntry.location`) stays a free string, so
// `normalizeTimeLocation` below is what every surface uses to resolve a
// raw string back into one of these four — unknown values default to
// `'office'`, which preserves historical behaviour (home vs. office was
// the only pre-existing distinction).
//
// `timeoff` (F6, 2026-10-19) is a UI-only pseudo-location: it never
// lands on `TimeEntry.location` — picking it switches the form into
// "Timeoff mode" which routes writes to AbsenceRecord or a bucket-
// tagged TimeEntry depending on the selected category. The surfaces
// that OPT OUT of Timeoff pass `allowTimeoff={false}` (the default),
// so adding it here is backward-compatible for every existing
// consumer.
export type TimeLocation = 'office' | 'home' | 'site' | 'timeoff';

export interface LocationToggleProps {
  value: TimeLocation;
  onChange: (next: TimeLocation) => void;
  /** `sm` for compact rows (tight toolbars), `md` for forms (default). */
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
  /**
   * F6 (2026-10-19) — opt into the 4th "Timeoff" option. Default `false`
   * so every existing consumer (task-drawer time tab, kanban quick-log)
   * keeps rendering the 3-way Home/Office/Site control unchanged. Only
   * the self-service surfaces (weekly timesheet + log-time dialog) pass
   * `true`, where Timeoff mode is meaningful.
   */
  allowTimeoff?: boolean;
}

// ─── Shared helpers (icon / label / emoji / normaliser) ────────────────────
// Exported so entry-display rows, compact rows, lists, etc. can resolve a
// location without re-implementing the mapping.
export const TIME_LOCATION_LABELS: Record<TimeLocation, string> = {
  home: 'Home',
  office: 'Office',
  site: 'Site',
  timeoff: 'Timeoff',
};

export const TIME_LOCATION_EMOJI: Record<TimeLocation, string> = {
  home: '🏠',
  office: '🏢',
  site: '📍',
  timeoff: '📅',
};

// Any raw string from the backend becomes a `TimeLocation`. The default
// (and anything unknown) falls back to `'office'` so legacy rows that
// predate this control keep their current visual. `timeoff` is never
// written to `TimeEntry.location` (see type note above) — kept here only
// so a defensive normaliser round-trips it when a FE caller passes it.
export function normalizeTimeLocation(v: string | null | undefined): TimeLocation {
  if (v === 'home' || v === 'site' || v === 'timeoff') return v;
  return 'office';
}

// 1-line icon component rendering the matching lucide icon for `value`.
// Kept here so every surface imports a single resolver — swapping Site's
// icon later is a one-file change.
export function TimeLocationIcon({ value, className }: { value: TimeLocation; className?: string }) {
  if (value === 'home') return <Home className={className} aria-hidden="true" />;
  if (value === 'site') return <MapPin className={className} aria-hidden="true" />;
  if (value === 'timeoff') return <Calendar className={className} aria-hidden="true" />;
  return <Building2 className={className} aria-hidden="true" />;
}

// ─── Component ─────────────────────────────────────────────────────────────
// Segmented control (Home / Office / Site [+ Timeoff when opted-in]).
// The 3 location options keep the existing weekly-timesheet selected
// treatment (`bg-blue-100 text-blue-700` / `dark:bg-blue-500/15 dark:text-blue-400`);
// the Timeoff option (F6) uses a distinct amber tint so it reads as a
// mode switch, not a 4th location.
const BASE_OPTIONS: ReadonlyArray<{ value: Exclude<TimeLocation, 'timeoff'>; label: string }> = [
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
  allowTimeoff = false,
}: LocationToggleProps) {
  const isSm = size === 'sm';
  // Icon size tracks the segmented-control size — 12px for `sm` (tight
  // toolbars) and 14px for `md` (forms). Matches the historical weekly
  // timesheet pair which rendered 14px icons.
  const iconCls = isSm ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const options: ReadonlyArray<{ value: TimeLocation; label: string }> = allowTimeoff
    ? [...BASE_OPTIONS, { value: 'timeoff', label: TIME_LOCATION_LABELS.timeoff }]
    : BASE_OPTIONS;

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
      {options.map((opt) => {
        const selected = opt.value === value;
        const isTimeoff = opt.value === 'timeoff';
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
                ? isTimeoff
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400'
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
