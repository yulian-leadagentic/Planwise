import type { DueBucket } from './types';

export const columns = [
  { id: 'not_started', label: 'To Do', color: 'border-t-slate-400', bg: 'bg-slate-50/50 dark:bg-slate-800/50' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-blue-500', bg: 'bg-blue-50/30' },
  { id: 'in_review', label: 'In Review', color: 'border-t-violet-500', bg: 'bg-violet-50/30' },
  { id: 'completed', label: 'Done', color: 'border-t-emerald-500', bg: 'bg-emerald-50/30' },
];

// zoneBorderColors imported from '@/lib/task-constants' as ZONE_BORDER_COLORS

/**
 * Time dropdown — 15-minute slots from 06:00 to 22:00, same options
 * the Add Timesheet Entry modal uses. Extracted so QuickTimeLog and
 * the My Tasks list-view row share the same control shape (V10
 * unification: every time-entry UI in the app reads the same).
 */
export const TIME_SLOTS: string[] = (() => {
  const slots: string[] = [];
  for (let h = 6; h <= 22; h++) {
    for (const m of [0, 15, 30, 45]) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
})();

export const DUE_BUCKETS: { key: DueBucket; label: string; tone: string }[] = [
  { key: 'overdue',   label: 'Overdue',     tone: 'border-red-200 bg-red-50/40 text-red-700' },
  { key: 'today',     label: 'Due Today',   tone: 'border-amber-200 bg-amber-50/40 text-amber-700' },
  { key: 'this_week', label: 'This Week',   tone: 'border-blue-200 bg-blue-50/40 text-blue-700' },
  { key: 'next_week', label: 'Next Week',   tone: 'border-violet-200 bg-violet-50/40 text-violet-700' },
  { key: 'later',     label: 'Later',       tone: 'border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300' },
  { key: 'no_date',   label: 'No Due Date', tone: 'border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400' },
];
