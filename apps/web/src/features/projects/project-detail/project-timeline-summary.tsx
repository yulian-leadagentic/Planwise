/**
 * Project timeline summary (WORKORDER §5 · 2026-11-10).
 *
 * A compact strip above the project tab bar that surfaces the
 * scheduler-derived timeline window for the whole project — the DAG
 * forward-pass output written back by `scheduler.service.ts` onto each
 * task (`estimatedStartDate` / `endDate` / `onCriticalPath`).
 *
 * The existing "Timeline:" chip on the project header meta row shows
 * the MANUAL `project.startDate` / `project.endDate` fields. This strip
 * shows the COMPUTED window reduced from the actual task plan, so the
 * two are intentionally distinct — manual plan vs. derived schedule.
 *
 * Data source — no extra round-trip:
 *   Reuses the same `['planning', projectId]` query the planning grid
 *   and the brief-tiles row already populate, so this strip piggybacks
 *   on their fetch and shares the react-query cache.
 *
 * Reduction rules:
 *   - earliestStart = MIN(estimatedStartDate) across tasks whose status
 *                     is not `cancelled`. Completed tasks ARE included
 *                     — their fixed dates still anchor the project
 *                     range.
 *   - latestFinish  = MAX(endDate) over the same filter.
 *   - durationCalendarDays = inclusive calendar-day count between the
 *                     two (both endpoints count). We stick to calendar
 *                     days here instead of shipping a working-days
 *                     calculator on the FE — a parallel FE walk would
 *                     risk diverging from the BE scheduler's org
 *                     calendar (holidays, weekly rest days,
 *                     partial-day overrides). The BE scheduler stays
 *                     the authority for working-day math.
 *   - If NO task carries both a start and an end date, the strip
 *     renders `—` muted (empty state).
 *
 * Bonus (WORKORDER §5.3): a "N tasks on Critical Path" chip when the
 * scheduler has flagged any task with `onCriticalPath === true`.
 */

import { useQuery } from '@tanstack/react-query';
import { parseISO, format, differenceInCalendarDays, isValid } from 'date-fns';
import client from '@/api/client';

interface TaskLite {
  id: number;
  status?: string | null;
  estimatedStartDate?: string | null;
  endDate?: string | null;
  onCriticalPath?: boolean | null;
}

interface PlanningLite {
  tasks?: TaskLite[];
}

function parseMaybe(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = parseISO(value);
  return isValid(d) ? d : null;
}

function computeTimelineSummary(tasks: TaskLite[]): {
  earliestStart: Date;
  latestFinish: Date;
  durationCalendarDays: number;
  criticalPathCount: number;
} | null {
  let earliest: number | null = null;
  let latest: number | null = null;
  let cp = 0;
  for (const t of tasks) {
    if ((t?.status ?? '').toLowerCase() === 'cancelled') continue;
    if (t?.onCriticalPath) cp += 1;
    const s = parseMaybe(t?.estimatedStartDate);
    const e = parseMaybe(t?.endDate);
    if (s && (earliest == null || s.getTime() < earliest)) earliest = s.getTime();
    if (e && (latest == null || e.getTime() > latest)) latest = e.getTime();
  }
  if (earliest == null || latest == null) return null;
  const startDate = new Date(earliest);
  const endDate = new Date(latest);
  // +1 → inclusive-day count. A plan whose only task starts and ends on
  // the same day reads as "1 day"; a 2026-11-17 → 2026-12-01 window
  // reads as 15 days, matching how the scheduler reports task
  // durations (both endpoints count).
  const durationCalendarDays = Math.max(1, differenceInCalendarDays(endDate, startDate) + 1);
  return { earliestStart: startDate, latestFinish: endDate, durationCalendarDays, criticalPathCount: cp };
}

/**
 * NOTE: this component intentionally mounts the same `['planning', projectId]`
 * query the planning grid uses. react-query dedupes concurrent fetches
 * and shares cached payloads — no extra request, no risk of a stale
 * second copy drifting from the grid's view.
 */
export function ProjectTimelineSummary({ projectId }: { projectId: number }) {
  const { data } = useQuery<PlanningLite>({
    queryKey: ['planning', projectId],
    queryFn: () =>
      client.get(`/projects/${projectId}/planning-data`).then((r) => r.data?.data ?? r.data),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const summary = computeTimelineSummary(tasks);

  return (
    <div
      className="flex items-center gap-4 px-4 py-2 bg-[#FAFBFC] dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-700 text-[13px]"
      data-testid="project-timeline-summary"
    >
      <div
        className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-[0.05em]"
        title="Scheduler-derived project window — earliest task start to latest task end across the DAG forward pass."
      >
        Timeline
      </div>
      {summary ? (
        <>
          <div className="flex items-center gap-2 font-mono text-xs text-slate-700 dark:text-slate-200 tabular-nums">
            <span>{format(summary.earliestStart, 'yyyy-MM-dd')}</span>
            <span className="text-slate-400 dark:text-slate-500" aria-hidden="true">
              →
            </span>
            <span>{format(summary.latestFinish, 'yyyy-MM-dd')}</span>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
            · {summary.durationCalendarDays} {summary.durationCalendarDays === 1 ? 'day' : 'days'} (calendar)
          </span>
          {summary.criticalPathCount > 0 && (
            <span
              className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums"
              title="Tasks the scheduler flagged on the critical path (float = 0)."
            >
              · {summary.criticalPathCount} task{summary.criticalPathCount === 1 ? '' : 's'} on Critical Path
            </span>
          )}
        </>
      ) : (
        <span className="font-mono text-xs text-slate-400 dark:text-slate-500">—</span>
      )}
    </div>
  );
}
