/**
 * Shared "due window" filter for near-due task surfaces
 * (My Tasks kanban + Execution Review). QA3 Wave-3 Commit 9 · PR-033,
 * also covers Tzlil's My-Tasks note #5.
 *
 * Semantics (locked, forward-looking, NOT symmetric rolling):
 *  - 'all'   — passes every task; the control is inactive.
 *  - 'day'   — dueDate ≤ end-of-today (local).
 *  - 'week'  — dueDate ≤ now + 7 days.
 *  - 'month' — dueDate ≤ now + 30 days.
 *
 * All windows INCLUDE overdue open tasks (dueDate < now while the task
 * is still open) so users can see everything they need to act on in
 * that horizon. Tasks in terminal states (completed / cancelled) drop
 * out — they're not "due" anymore. Tasks with no dueDate drop out
 * whenever a window is active (there's nothing to compare against).
 *
 * The status filter is intentionally OPEN-inclusive: we treat every
 * non-terminal status as "open". Callers that want a tighter set
 * should compose an additional status filter on top of this one.
 */

export type DueWindow = 'all' | 'day' | 'week' | 'month';

/** Values in [DueWindow] the segmented picker offers. */
export const DUE_WINDOW_OPTIONS: ReadonlyArray<{ value: DueWindow; label: string; title: string }> = [
  { value: 'all',   label: 'All',   title: 'No due-date filter — show every task' },
  { value: 'day',   label: 'Day',   title: 'Due today or already overdue and still open' },
  { value: 'week',  label: 'Week',  title: 'Due in the next 7 days or already overdue' },
  { value: 'month', label: 'Month', title: 'Due in the next 30 days or already overdue' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

interface DueTask {
  endDate?: string | Date | null;
  status?: string | null;
}

/**
 * Test whether `task` passes the given due window. `now` is injected
 * so callers can memoize a single reference time across a filter loop
 * (avoids a per-task Date.now() and keeps the window boundary stable
 * during the same tick).
 */
export function matchesDueWindow(task: DueTask, window: DueWindow, now: number = Date.now()): boolean {
  if (window === 'all') return true;
  if (!task.endDate) return false;
  if (task.status && TERMINAL_STATUSES.has(task.status)) return false;

  const due = new Date(task.endDate).getTime();
  if (!Number.isFinite(due)) return false;

  // Overdue open tasks always pass — they belong on the "act now" list.
  if (due < now) return true;

  const nowD = new Date(now);
  let cutoff: number;
  if (window === 'day') {
    // End of TODAY in local time. Anchoring on the local date so a task
    // due at 23:30 today still counts as "today", even at 10:00 in the
    // morning.
    const eod = new Date(nowD);
    eod.setHours(23, 59, 59, 999);
    cutoff = eod.getTime();
  } else if (window === 'week') {
    cutoff = now + 7 * DAY_MS;
  } else {
    cutoff = now + 30 * DAY_MS;
  }
  return due <= cutoff;
}
