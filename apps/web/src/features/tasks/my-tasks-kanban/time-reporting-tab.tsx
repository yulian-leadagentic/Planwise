import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, User as UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeApi } from '@/api/time.api';
import { queryKeys } from '@/lib/query-keys';
import type { SortField, SortDir } from './types';
import { compareTasks } from './helpers';
import { TimeReportingRow } from './time-reporting-row';

export function TimeReportingTab({ tasks, onOpenDrawer }: { tasks: any[]; onOpenDrawer: (id: number) => void }) {
  // Column sort state per user request 2026-06-22. Default: no sort
  // (null) preserves the existing relevance-based order from the parent.
  // Clicking a header toggles asc → desc → off; clicking a different
  // header resets dir to asc.
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const onHeaderClick = (field: SortField) => {
    if (sortField !== field) { setSortField(field); setSortDir('asc'); return; }
    if (sortDir === 'asc') { setSortDir('desc'); return; }
    setSortField(null);
    setSortDir('asc');
  };

  const sortedTasks = useMemo(() => {
    if (!sortField) return tasks;
    return [...tasks].sort((a, b) => compareTasks(a, b, sortField, sortDir));
  }, [tasks, sortField, sortDir]);

  const activeTasks = sortedTasks.filter((t) => t.status !== 'completed');
  const completedTasks = sortedTasks.filter((t) => t.status === 'completed');

  // Fetch recent time entries for today
  const today = new Date().toISOString().split('T')[0];
  const { data: recentEntriesData } = useQuery({
    queryKey: queryKeys.time.entries({ date: today }),
    queryFn: () => timeApi.listEntries({ date: today }),
    staleTime: 30 * 1000,
  });
  const recentEntries = (() => {
    const raw = recentEntriesData as any;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    if (raw.entries && Array.isArray(raw.entries)) return raw.entries;
    return [];
  })();

  const todayTotal = recentEntries.reduce((s: number, e: any) => s + (e.minutes ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* Today's summary */}
      {todayTotal > 0 && (
        <div className="rounded-[14px] border border-green-200 bg-green-50 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-green-600" />
            <span className="text-[13px] font-semibold text-green-800">Today's total</span>
          </div>
          <span className="text-lg font-bold text-green-700">{(todayTotal / 60).toFixed(2)}h</span>
        </div>
      )}

      {/* Sort-by chip row — separate from the in-row header below so
          users can sort by columns that DON'T have a corresponding
          input on each row (project, status). The label flips between
          "▲" / "▼" / unset and the field clears on a third click. */}
      <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="font-semibold uppercase tracking-wider">Sort by</span>
        {([
          { field: 'project' as const, label: 'Project' },
          { field: 'task' as const, label: 'Task' },
          { field: 'status' as const, label: 'Status' },
          { field: 'due' as const, label: 'Due Date' },
        ]).map((c) => {
          const active = sortField === c.field;
          return (
            <button
              key={c.field}
              type="button"
              onClick={() => onHeaderClick(c.field)}
              className={cn(
                'rounded-md border px-2 py-0.5 font-medium transition-colors',
                active
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              {c.label}
              {active && <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>}
            </button>
          );
        })}
      </div>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">Active Tasks</h3>
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-600">{activeTasks.length}</span>
            </div>
            {/* Header labels — widths MUST match TimeReportingRow's column
                widths exactly so columns line up. Source-of-truth for the
                row widths is at TimeReportingRow above: w-[96px] Due,
                w-[130px] Date, w-[80px] Start/End, w-[58px] Total, w-14
                Details button, ~w-[68px] Log button. */}
            <div className="flex items-center gap-2 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider pr-1">
              <span className="w-[96px] text-center">Due</span>
              <span className="w-[130px] text-center">Date</span>
              <span className="w-[80px] text-center">Start Time</span>
              <span className="w-[80px] text-center">End Time</span>
              <span className="w-[58px] text-center">Total Hours</span>
              <span className="w-14" />
              <span className="w-[68px]" />
            </div>
          </div>
          {activeTasks.map((task: any) => <TimeReportingRow key={task.id} task={task} onOpenDrawer={onOpenDrawer} />)}
        </div>
      )}

      {/* Completed tasks (collapsed) */}
      {completedTasks.length > 0 && (
        <details className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <summary className="bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 cursor-pointer">
            <span className="text-[13px] font-semibold text-slate-500 dark:text-slate-400">Completed Tasks</span>
            <span className="ml-2 rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 dark:text-slate-400">{completedTasks.length}</span>
          </summary>
          {completedTasks.map((task: any) => <TimeReportingRow key={task.id} task={task} onOpenDrawer={onOpenDrawer} />)}
        </details>
      )}

      {/* Recent entries today */}
      {recentEntries.length > 0 && (
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
            <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">Today's Entries ({recentEntries.length})</h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {recentEntries.map((e: any) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                <span className="text-slate-500 dark:text-slate-400 w-28">{e.startTime ?? '-'} – {e.endTime ?? '-'}</span>
                <span className="font-semibold text-slate-700 dark:text-slate-200 w-14">{((e.minutes ?? 0) / 60).toFixed(2)}h</span>
                <span className="text-blue-600 font-medium">{e.project?.name ?? ''}</span>
                <span className="text-slate-500 dark:text-slate-400 flex-1 truncate">{e.task?.name ?? ''}</span>
                {e.note && <span className="text-slate-600 dark:text-slate-300 truncate max-w-[200px]">{e.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {tasks.length === 0 && (
        <div className="py-12 text-center">
          <UserIcon className="mx-auto h-12 w-12 text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">No tasks assigned to you</p>
        </div>
      )}
    </div>
  );
}
