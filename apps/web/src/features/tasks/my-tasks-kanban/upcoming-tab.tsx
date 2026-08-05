import { useMemo } from 'react';
import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DUE_BUCKETS } from './constants';
import type { DueBucket } from './types';
import { bucketForTask } from './helpers';
import { TimeReportingRow } from './time-reporting-row';

/**
 * "Upcoming" view — same row component as the time-reporting list, but
 * grouped by due-date proximity. Buckets are rendered in urgency order
 * (Overdue first), and empty buckets are skipped so the page stays
 * focused on actionable work.
 */
export function UpcomingTab({ tasks, onOpenDrawer }: { tasks: any[]; onOpenDrawer: (id: number) => void }) {
  const todayMs = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  }, []);

  const grouped = useMemo(() => {
    const m = new Map<DueBucket, any[]>();
    for (const b of DUE_BUCKETS) m.set(b.key, []);
    for (const t of tasks) m.get(bucketForTask(t, todayMs))!.push(t);
    // Within each bucket, sort by endDate ascending (sooner first; tasks
    // without a date go to the end), with task id as tie-breaker.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const aT = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY;
        const bT = b.endDate ? new Date(b.endDate).getTime() : Number.POSITIVE_INFINITY;
        return (aT - bT) || (a.id ?? 0) - (b.id ?? 0);
      });
    }
    return m;
  }, [tasks, todayMs]);

  return (
    <div className="space-y-4">
      {DUE_BUCKETS.map((b) => {
        const list = grouped.get(b.key) ?? [];
        if (list.length === 0) return null;
        return (
          <div key={b.key} className={cn('rounded-[14px] border bg-white dark:bg-slate-900 overflow-hidden', b.tone)}>
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between bg-white/60">
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold">{b.label}</h3>
                <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">{list.length}</span>
              </div>
            </div>
            {list.map((task: any) => (
              <TimeReportingRow key={task.id} task={task} onOpenDrawer={onOpenDrawer} />
            ))}
          </div>
        );
      })}
      {/* Empty state when zero tasks across all buckets (shouldn't happen
          when the list is non-empty above, but defensive for stale data) */}
      {tasks.length === 0 && (
        <div className="py-12 text-center">
          <CalendarClock className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Nothing on your plate right now.</p>
        </div>
      )}
    </div>
  );
}
