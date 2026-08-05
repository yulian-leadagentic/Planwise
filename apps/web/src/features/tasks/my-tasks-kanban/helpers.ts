import { formatShortDate } from '@/lib/task-constants';
import type { DueBucket, SortField, SortDir } from './types';

export function getTaskScore(task: any): number {
  let score = 0;
  const now = Date.now();
  if (task.endDate) {
    const daysUntilDue = (new Date(task.endDate).getTime() - now) / 86400000;
    if (daysUntilDue < 0) score += 1000;
    else if (daysUntilDue < 3) score += 500;
    else if (daysUntilDue < 7) score += 200;
    else if (daysUntilDue < 14) score += 100;
    else score += 50;
  }
  if (task.priority === 'critical') score += 400;
  else if (task.priority === 'high') score += 200;
  else if (task.priority === 'medium') score += 50;
  if (task.budgetHours && Number(task.budgetHours) > 0) score += 20;
  return score;
}

// Calculate "Start no later than" = dueDate - estimatedHours (in working days)
export function getStartByDate(task: any): string | null {
  if (!task.endDate || !task.budgetHours) return null;
  const hours = Number(task.budgetHours);
  if (hours <= 0) return null;
  const workingDays = Math.ceil(hours / 8); // 8h per day
  const due = new Date(task.endDate);
  let d = new Date(due);
  let counted = 0;
  while (counted < workingDays) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 5 && dow !== 6) counted++; // Skip Fri+Sat
  }
  // task-constants formatShortDate takes ISO strings — hand it the
  // yyyy-mm-dd slice rather than the Date object.
  return formatShortDate(d.toISOString().slice(0, 10));
}

/**
 * Decide which Upcoming bucket a task belongs to.
 *
 * Buckets reflect what the user needs to ACT on this week — not just
 * "when is the deadline?". A 2-month task that started last week and
 * is due next month still belongs in "This Week", because the user is
 * actively working on it now. The old version only looked at endDate,
 * so multi-week tasks slid into "Later" and disappeared from the
 * actionable view.
 *
 * Priority (first match wins):
 *   1. completed/cancelled → 'later' (out of focus)
 *   2. endDate in the past → 'overdue' (must catch up)
 *   3. endDate == today → 'today'
 *   4. [startDate, endDate] overlaps [today, today+7d] → 'this_week'
 *      (covers: starts/ends this week, AND active multi-week tasks
 *       whose start is already in the past)
 *   5. starts or ends in days 8–14 → 'next_week'
 *   6. else → 'later'
 *   7. no startDate AND no endDate → 'no_date'
 */
export function bucketForTask(task: any, todayMs: number): DueBucket {
  if (task.status === 'completed' || task.status === 'cancelled') return 'later';

  const dayMs = 86_400_000;
  const startMs = task.startDate ? new Date(task.startDate).getTime() : null;
  const endMs = task.endDate ? new Date(task.endDate).getTime() : null;

  if (startMs == null && endMs == null) return 'no_date';

  // Overdue — endDate in the past
  if (endMs != null && endMs < todayMs) return 'overdue';

  // Due today — endDate is exactly today
  if (endMs != null) {
    const dueDay = Math.floor((endMs - todayMs) / dayMs);
    if (dueDay === 0) return 'today';
  }

  const weekEndMs = todayMs + 7 * dayMs;
  // "Active this week" — the task's [startDate, endDate] window overlaps
  // the next 7 days. A null endDate is treated as open-ended (still
  // ongoing). A null startDate falls back to the endDate-only check so
  // deadline-only tasks still slot in.
  const startsByEndOfWeek = startMs != null && startMs <= weekEndMs;
  const stillOpenOrLater = endMs == null || endMs >= todayMs;
  const endsThisWeek = endMs != null && endMs <= weekEndMs;
  if ((startsByEndOfWeek && stillOpenOrLater) || endsThisWeek) {
    return 'this_week';
  }

  const twoWeeksMs = todayMs + 14 * dayMs;
  const startsNextWeek = startMs != null && startMs > weekEndMs && startMs <= twoWeeksMs;
  const endsNextWeek = endMs != null && endMs > weekEndMs && endMs <= twoWeeksMs;
  if (startsNextWeek || endsNextWeek) return 'next_week';

  return 'later';
}

/** Pure comparator — keeps task IDs stable when sort keys collide. */
export function compareTasks(a: any, b: any, field: SortField, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  const tieBreak = (a.id ?? 0) - (b.id ?? 0);
  switch (field) {
    case 'task':
      return sign * String(a.name ?? '').localeCompare(String(b.name ?? '')) || tieBreak;
    case 'project':
      return sign * String(a.project?.name ?? '').localeCompare(String(b.project?.name ?? '')) || tieBreak;
    case 'status': {
      // Order by workflow stage so "Not started → In progress → In review →
      // Done" is the natural ascending order, regardless of the string
      // alphabet.
      const rank: Record<string, number> = { not_started: 0, in_progress: 1, in_review: 2, completed: 3, on_hold: 4, cancelled: 5 };
      return sign * ((rank[a.status] ?? 99) - (rank[b.status] ?? 99)) || tieBreak;
    }
    case 'due': {
      const aT = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
      const bT = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
      return sign * (aT - bT) || tieBreak;
    }
  }
}
