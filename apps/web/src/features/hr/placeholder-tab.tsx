import type { LucideIcon } from 'lucide-react';
import { CalendarCheck, Settings2 } from 'lucide-react';

/**
 * HR Phase A4 (2026-10-15) — "Coming soon" state for the HR tabs that
 * were locked for later phases. Phase D2 (2026-10-18) lit up Reports,
 * leaving no live callers for the placeholder today — the component
 * stays exported so a future tab (if any) can reuse the chrome, and
 * the Monthly Review / Settings exports are kept harmless as safety
 * nets even though both tabs are now wired to real pages.
 */
export interface PlaceholderTabProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function PlaceholderTab({ icon: Icon, title, description }: PlaceholderTabProps) {
  return (
    <div className="min-h-[320px] rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6">
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[14px] bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500">
          <Icon className="h-7 w-7" aria-hidden="true" />
        </div>
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h2>
        <p className="mt-2 max-w-md text-[13px] text-slate-500 dark:text-slate-400">
          {description}
        </p>
        <span className="mt-5 inline-flex items-center rounded-[5px] bg-amber-50 dark:bg-amber-900/30 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          בקרוב · Coming soon
        </span>
      </div>
    </div>
  );
}

// ─── Pre-wrapped tabs for the router ──────────────────────────────────
// Phase B/C/D replaced each real tab with a live page. These wrappers
// stay as fallbacks for any future screen that still needs the
// placeholder chrome; the current router doesn't import them.

export function HrMonthlyReviewPlaceholder() {
  return (
    <PlaceholderTab
      icon={CalendarCheck}
      title="Monthly review"
      description="End-of-month timesheet review + payroll export lands in Phase B."
    />
  );
}

export function HrSettingsPlaceholder() {
  return (
    <PlaceholderTab
      icon={Settings2}
      title="Settings"
      description="Organisation-wide HR knobs (holiday-eve length, min work day) land in Phase C."
    />
  );
}
