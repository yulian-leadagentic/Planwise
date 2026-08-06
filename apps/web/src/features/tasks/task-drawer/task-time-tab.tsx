import { Clock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';
import { queryKeys } from '@/lib/query-keys';
import { TimeEntryForm } from '@/features/time/time-entry-form';
import { TimeEntryRow } from './time-entry-row';

export function TaskTimeTab({ taskId }: { taskId: number }) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: queryKeys.time.entriesByTask(taskId),
    queryFn: () => client.get('/time-entries', { params: { taskId } }).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
  });

  const list = entries as any[];
  const totalMinutes = list.reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);
  const billableMinutes = list.filter((e: any) => e.isBillable).reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      <TimeEntryForm taskId={taskId} variant="full" />

      {/* Reporting history — every entry the current user has logged on
          this task, newest first. Surfaces the full picture (not just
          today's entry) so users can verify what they've already
          reported. Server-side, the /time-entries route is scoped to
          the caller's userId, so this is *your* reporting only. */}
      <div className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
            <span className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">Your reporting history</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] tabular-nums">
            <span className="text-slate-500 dark:text-slate-400">
              {list.length} {list.length === 1 ? 'entry' : 'entries'}
            </span>
            <span className="text-slate-700 dark:text-slate-200 font-bold">
              {(totalMinutes / 60).toFixed(2)}h
            </span>
            {billableMinutes !== totalMinutes && (
              <span className="text-slate-400 dark:text-slate-500">
                ({(billableMinutes / 60).toFixed(2)}h billable)
              </span>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="px-3 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">Loading entries…</div>
        ) : list.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-slate-400 dark:text-slate-500 italic">
            No entries yet — use the form above to log your first.
          </div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
            {list.map((e: any) => (
              <TimeEntryRow key={e.id} entry={e} taskId={taskId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
