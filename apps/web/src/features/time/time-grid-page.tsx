import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { ProjectSelect } from '@/components/shared/project-select';
import { useStickyHScroll } from '@/components/shared/sticky-h-scroll';
import { MinutesInput } from '@/components/shared/minutes-input';
import { useWeeklyGrid, useCreateTimeEntry, useUpdateTimeEntry } from '@/hooks/use-time';
import { useFilterStore } from '@/stores/filter.store';
import { getWeekDates, addDays, startOfWeek, format } from '@/lib/date-utils';
import { minutesToDisplay } from '@/types';
import { Skeleton } from '@/components/shared/loading-skeleton';

export function TimeGridPage() {
  const scrollRef = useStickyHScroll();
  const [weekOffset, setWeekOffset] = useState(0);
  const { timeProjectId, setTimeFilters } = useFilterStore();

  const currentWeekStart = useMemo(() => {
    const today = new Date();
    const start = startOfWeek(today, { weekStartsOn: 1 });
    return addDays(start, weekOffset * 7);
  }, [weekOffset]);

  const weekStartStr = format(currentWeekStart, 'yyyy-MM-dd');
  const weekDates = getWeekDates(currentWeekStart);
  const dayKeys = weekDates.map((d) => format(d, 'yyyy-MM-dd'));

  const { data: grid, isLoading } = useWeeklyGrid({
    weekStart: weekStartStr,
    projectId: timeProjectId ?? undefined,
  });

  const createEntry = useCreateTimeEntry();
  const updateEntry = useUpdateTimeEntry();

  // A cell holding several entries can't be edited as one number —
  // changing `id`'s minutes to the typed total would double-count the
  // others. Those cells are read-only here (edit them on /time).
  const entryCount = (cell: NonNullable<typeof grid>['rows'][0]['days'][string]) =>
    cell ? cell.entries?.length ?? 1 : 0;

  const handleCellChange = (
    row: NonNullable<typeof grid>['rows'][0],
    dayKey: string,
    minutes: number,
  ) => {
    const existing = row.days[dayKey];
    if (existing) {
      if (minutes === 0 || entryCount(existing) > 1) return;
      updateEntry.mutate({ id: existing.id, minutes });
    } else if (minutes > 0 && row.taskId != null) {
      createEntry.mutate({
        taskId: row.taskId,
        projectId: row.projectId,
        date: dayKey,
        minutes,
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Weekly Grid" description="Log time across tasks and days" />

      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ProjectSelect
          value={timeProjectId}
          onChange={(id) => setTimeFilters({ timeProjectId: id })}
          placeholder="All projects"
          className="sm:w-64"
        />

        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset((o) => o - 1)} className="rounded-md p-1.5 hover:bg-accent">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-[200px] text-center text-sm font-medium">
            {format(weekDates[0], 'MMM d')} - {format(weekDates[6], 'MMM d, yyyy')}
          </span>
          <button
            onClick={() => setWeekOffset((o) => o + 1)}
            disabled={weekOffset >= 0}
            className="rounded-md p-1.5 hover:bg-accent disabled:opacity-50"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <Skeleton className="h-96" />
      ) : !grid || grid.rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No tasks found for this period. Log time to tasks to see them here.
        </div>
      ) : (
        <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="min-w-[200px] px-3 py-2 text-left font-medium text-muted-foreground">
                  Task
                </th>
                {weekDates.map((date, i) => (
                  <th
                    key={dayKeys[i]}
                    className="min-w-[80px] px-2 py-2 text-center font-medium text-muted-foreground"
                  >
                    <div>{format(date, 'EEE')}</div>
                    <div className="text-xs">{format(date, 'MMM d')}</div>
                  </th>
                ))}
                <th className="min-w-[80px] px-3 py-2 text-center font-medium text-muted-foreground">
                  Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {grid.rows.map((row, rowIdx) => (
                <tr key={`${row.taskId}-${row.projectId}-${rowIdx}`} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <p className="truncate font-medium">{row.taskName ?? row.projectName}</p>
                    {row.labelPath && (
                      <p className="truncate text-xs text-muted-foreground">{row.labelPath}</p>
                    )}
                  </td>
                  {dayKeys.map((dayKey) => {
                    const cell = row.days[dayKey];
                    const count = entryCount(cell);
                    if (cell && count > 1) {
                      return (
                        <td key={dayKey} className="px-1 py-1">
                          <div
                            className="w-full rounded-md border border-dashed border-input px-3 py-2 text-center font-mono text-xs tabular-nums text-muted-foreground"
                            title={`${count} entries — edit them on the Timesheet page`}
                          >
                            {minutesToDisplay(cell.minutes)}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={dayKey} className="px-1 py-1">
                        <MinutesInput
                          value={cell?.minutes ?? 0}
                          onChange={(minutes) => handleCellChange(row, dayKey, minutes)}
                          // Task-less (project) rows are legacy entries: new
                          // time always needs a task.
                          disabled={!cell && row.taskId == null}
                          className="w-full text-center text-xs"
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center font-medium">
                    {minutesToDisplay(row.weekTotalMinutes)}
                  </td>
                </tr>
              ))}

              {/* Daily totals */}
              <tr className="bg-muted/50 font-medium">
                <td className="px-3 py-2">Daily Total</td>
                {dayKeys.map((dayKey) => (
                  <td key={dayKey} className="px-2 py-2 text-center">
                    {grid.dailyTotals[dayKey]
                      ? minutesToDisplay(grid.dailyTotals[dayKey].logged)
                      : '-'}
                  </td>
                ))}
                <td className="px-3 py-2 text-center">
                  {minutesToDisplay(grid.weekSummary.totalLogged)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
