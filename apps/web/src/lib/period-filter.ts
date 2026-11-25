/**
 * Calendar-period filter for the My Tasks board (UI-6, QA5 Wave 2).
 *
 * REPLACES the forward-rolling `due-window.ts` cuts (Day = +0d, Week =
 * +7d, Month = +30d) that still back the Execution Review board and
 * Executive dashboard. On My Tasks the user wants CALENDAR semantics:
 *   Day   — today, local midnight → next midnight
 *   Week  — current calendar week, Sunday → Friday (Israeli work week)
 *   Month — current calendar month, 1st day → last day
 *
 * Plus "blended" overlays that always pass regardless of the dateable
 * span: `status === 'in_progress'` and overdue open tasks. The blended
 * default puts in-progress / overdue work in front of the user even
 * when their due date is outside the current window — matching the
 * actual intent of "what should I act on this week".
 *
 * `any` and `custom` are the escape hatches: `any` passes everything,
 * `custom` is a strict dueDate range (`dueFrom <= dueDate <= dueTo`),
 * never blended, used by the explicit date inputs.
 *
 * Default on first load = `week` — the user wants to see what finishes,
 * starts, is in flight, or is already late this week.
 */

import { format } from 'date-fns';

export type MyTasksPeriod = 'any' | 'day' | 'week' | 'month' | 'custom';

export const PERIOD_OPTIONS: ReadonlyArray<{ value: MyTasksPeriod; label: string; title: string }> = [
  { value: 'any',    label: 'Any',    title: 'No period filter, show every task' },
  { value: 'day',    label: 'Day',    title: 'Today (plus overdue + in-progress)' },
  { value: 'week',   label: 'Week',   title: 'This calendar week, Sunday to Friday (plus overdue + in-progress)' },
  { value: 'month',  label: 'Month',  title: 'This calendar month (plus overdue + in-progress)' },
  { value: 'custom', label: 'Custom', title: 'Pick an explicit due-date range below' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

export interface PeriodTask {
  endDate?: string | Date | null;
  status?: string | null;
  budgetHours?: number | string | null;
}

/**
 * Current calendar-week range in LOCAL time, Sunday → Friday (Israeli
 * work week — a plain Date.getDay() of 0 is Sunday, so the start of
 * week needs no library arithmetic; same for the end of Friday).
 * Returns millisecond timestamps for cheap `<=` comparisons.
 */
export function weekRangeSunFri(now: number = Date.now()): { startMs: number; endMs: number } {
  const d = new Date(now);
  const dow = d.getDay(); // 0 Sun … 6 Sat
  const start = new Date(d);
  start.setDate(d.getDate() - dow);
  start.setHours(0, 0, 0, 0);
  // Friday is day 5 — add (5 - 0) = 5 days to Sunday, then 23:59:59.999.
  const end = new Date(start);
  end.setDate(start.getDate() + 5);
  end.setHours(23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Current calendar day in LOCAL time, 00:00:00 → 23:59:59. */
export function dayRangeToday(now: number = Date.now()): { startMs: number; endMs: number } {
  const d = new Date(now);
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Current calendar month in LOCAL time, 1st 00:00 → last day 23:59. */
export function monthRangeToday(now: number = Date.now()): { startMs: number; endMs: number } {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/**
 * Compute an estimated start date from a task's dueDate and
 * `budgetHours` (treated as the "estimated hours" for the task). Uses
 * the same 8h/day + Fri+Sat skip convention as my-tasks-kanban/helpers'
 * `getStartByDate` so the kanban and this filter stay in sync.
 * Returns `null` when the task has no due date or no positive budget.
 */
export function estimatedStartMs(task: PeriodTask): number | null {
  if (!task.endDate) return null;
  const hours = Number(task.budgetHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const workingDays = Math.ceil(hours / 8);
  const d = new Date(task.endDate);
  let counted = 0;
  while (counted < workingDays) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 5 && dow !== 6) counted++; // Skip Fri + Sat (Israeli weekend)
  }
  return d.getTime();
}

/**
 * Does the task pass the given period filter? Blended semantics for
 * day/week/month: in-progress + overdue tasks always pass; a task also
 * passes if its due date OR its computed start falls inside the range.
 * `any` passes everything; `custom` is a strict dueDate range.
 */
export function matchesPeriod(
  task: PeriodTask,
  period: MyTasksPeriod,
  now: number = Date.now(),
  customFromIso: string = '',
  customToIso: string = '',
  /**
   * PR-072 · overdue open tasks (due before now, so also before the
   * range) pass Day / Week / Month. On by default; the My Tasks
   * "Include overdue" checkbox turns it off.
   */
  opts: { includeOverdue?: boolean } = {},
): boolean {
  const includeOverdue = opts.includeOverdue ?? true;
  if (period === 'any') return true;

  if (period === 'custom') {
    // Strict range on dueDate only. Empty bounds = unbounded that side.
    if (!task.endDate) return false;
    const iso = String(task.endDate).slice(0, 10);
    if (customFromIso && iso < customFromIso) return false;
    if (customToIso && iso > customToIso) return false;
    return true;
  }

  // Blended day/week/month — in-progress and overdue overlay always pass.
  const status = task.status ?? '';
  if (status === 'in_progress') return true;

  if (task.endDate) {
    const dueMs = new Date(task.endDate).getTime();
    if (Number.isFinite(dueMs)) {
      // Overdue open task: passes while "Include overdue" is on.
      if (includeOverdue && dueMs < now && !TERMINAL_STATUSES.has(status)) return true;
    }
  }

  // Pick the calendar range for the picked period.
  const r = period === 'day'
    ? dayRangeToday(now)
    : period === 'week'
      ? weekRangeSunFri(now)
      : monthRangeToday(now);

  // Due date inside the range?
  if (task.endDate) {
    const dueMs = new Date(task.endDate).getTime();
    if (Number.isFinite(dueMs) && dueMs >= r.startMs && dueMs <= r.endMs) return true;
  }

  // Computed start inside the range? (dueDate − estimated working days)
  const sMs = estimatedStartMs(task);
  if (sMs != null && sMs >= r.startMs && sMs <= r.endMs) return true;

  return false;
}

/**
 * PR-072 · the calendar range a Day / Week / Month period covers, or
 * null for Any / Custom (Custom shows its own date inputs).
 * Week start: there is no org-level week-start setting (HrSettings only
 * carries weeklyRestDays, default Fri + Sat), so the week starts on
 * Sunday, and per the QA5 UI-6 decision Week runs Sunday to Friday.
 */
export function periodRange(
  period: MyTasksPeriod,
  now: number = Date.now(),
): { startMs: number; endMs: number } | null {
  if (period === 'day') return dayRangeToday(now);
  if (period === 'week') return weekRangeSunFri(now);
  if (period === 'month') return monthRangeToday(now);
  return null;
}

/**
 * PR-072 · readable label for a date range, with the shared month / year
 * written once: "Wed 25 Nov 2026", "Sun 22 – Fri 27 Nov 2026",
 * "Sun 29 Nov – Fri 4 Dec 2026", "Sun 27 Dec 2026 – Fri 1 Jan 2027".
 */
export function formatRangeLabel(startMs: number, endMs: number): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  const sameDay = sameMonth && s.getDate() === e.getDate();
  const end = format(e, 'EEE d MMM yyyy');
  if (sameDay) return end;
  const start = format(s, sameMonth ? 'EEE d' : sameYear ? 'EEE d MMM' : 'EEE d MMM yyyy');
  return `${start} – ${end}`;
}

/** PR-072 · label for the selected period's range, or null (Any / Custom). */
export function periodRangeLabel(period: MyTasksPeriod, now: number = Date.now()): string | null {
  const r = periodRange(period, now);
  return r ? formatRangeLabel(r.startMs, r.endMs) : null;
}
