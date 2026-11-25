import { useState, useMemo, Fragment } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PageSkeleton } from '@/components/shared/loading-skeleton';
import { cn } from '@/lib/utils';
import client from '@/api/client';
import { useNavigateWithReturn } from '@/components/nav/return-route';
import { useDrawerRoute } from '@/components/nav/use-drawer-route';
import { OverloadTasksPanel } from './parts/overload-tasks-panel';
import { OpsErrorBanner, opsErrorMessage } from './parts/ops-shared';
import { WorkloadDayHeaders } from './parts/workload-day-headers';
import {
  dayTasksTitle,
  formatWorkRange,
  groupByDepartment,
  shiftDateKey,
  utilizationPct,
  type TeamWorkload,
  type TeamWorkloadPerson,
} from './workload-range';

function getUtilColor(pct: number): string {
  if (pct === 0) return 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500';
  if (pct <= 50) return 'bg-green-100 text-green-700';
  if (pct <= 80) return 'bg-blue-100 text-blue-700';
  if (pct <= 100) return 'bg-amber-100 text-amber-700';
  return 'bg-red-200 text-red-700';
}

function getBarWidth(pct: number): string {
  return `${Math.min(100, pct)}%`;
}

/**
 * Legacy /dashboard/workload entry point.
 *
 * Consolidated in ux/breadcrumbs-dash — the Workload view now lives
 * as a tab inside the Operations dashboard (see operations-dashboard.tsx),
 * since both surfaces spoke to team capacity. This route is kept alive
 * as a redirect so bookmarks and external links keep resolving; the
 * body of the old page moved into <WorkloadPanel /> below and is
 * rendered by Operations when tab === 'workload'.
 */
export function WorkloadDashboardPage() {
  return <Navigate to="/operations?tab=workload" replace />;
}

const LOGGED_HIDDEN_TITLE = 'Logged hours are visible only for people you manage';

/**
 * WorkloadPanel — the daily-per-user utilization table. Rendered by
 * the Operations dashboard's Workload tab. No PageHeader here — the
 * hosting page owns the header + summary strip.
 *
 * QA6 P3 (PR-073) — ONE call to `GET /workload/team` for every active
 * employee (it was a request per person, the first 30 only, errors
 * swallowed). The days are the API's: the org work week, Sunday first.
 * Department filter + group-by come from the org tree the same call
 * returns; "My department only" on the page narrows it server-side.
 */
export function WorkloadPanel({ myDeptOnly = false }: { myDeptOnly?: boolean }) {
  const [weekOf, setWeekOf] = useState<string | null>(null); // null = this week
  const [viewMode, setViewMode] = useState<'utilization' | 'hours'>('utilization');
  const [orgUnitId, setOrgUnitId] = useState<string>('');
  const [groupByDept, setGroupByDept] = useState(false);
  const navWithReturn = useNavigateWithReturn();
  const { openDrawer: setDrawerTaskId } = useDrawerRoute('task');

  const params: Record<string, string> = {};
  if (weekOf) params.weekOf = weekOf;
  if (myDeptOnly) params.myDeptOnly = 'true';
  else if (orgUnitId) params.orgUnitId = orgUnitId;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TeamWorkload>({
    queryKey: ['workload', 'team', params],
    staleTime: 2 * 60 * 1000,
    retry: 1,
    placeholderData: (prev) => prev,
    queryFn: () => client.get('/workload/team', { params }).then((r) => r.data?.data ?? r.data),
  });

  const people: TeamWorkloadPerson[] = data?.people ?? [];
  const days = data?.days ?? [];
  const rangeLabel = formatWorkRange(days.map((d) => d.date));
  const groups = useMemo(() => (groupByDept ? groupByDepartment(people) : null), [groupByDept, people]);

  if (isLoading && !data) return <PageSkeleton />;

  // Summary stats. Kept as a slim strip inside the panel so the
  // Workload-specific numbers (avg utilization, overloaded count,
  // under-utilized count) remain visible even when this component
  // is embedded inside the Operations page — Operations' own summary
  // strip covers different metrics (overdue, blocked, in-review,
  // free capacity), so we still add value here.
  const avgUtil = data?.totals.utilizationPct ?? 0;
  const overloaded = people.filter((p) => p.totals.utilizationPct > 100).length;
  const underutil = people.filter((p) => p.totals.utilizationPct < 50 && p.totals.utilizationPct > 0).length;

  const renderRow = (p: TeamWorkloadPerson) => {
    const util = p.totals.utilizationPct;
    return (
      <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 text-[10px] font-semibold flex items-center justify-center shrink-0">
              {(p.firstName?.[0] ?? '') + (p.lastName?.[0] ?? '')}
            </div>
            <div className="min-w-0">
              <p className="font-medium text-slate-700 dark:text-slate-200 truncate">{p.firstName} {p.lastName}</p>
              {(p.position || (!groupByDept && p.orgUnit)) && (
                <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
                  {[p.position, groupByDept ? null : p.orgUnit?.name].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </div>
        </td>
        {p.days.map((d) => {
          const dayUtil = utilizationPct(d.planned, d.capacity);
          const title = dayTasksTitle(d.tasks);
          return (
            <td key={d.date} className="px-2 py-2.5 text-center" title={title || undefined}>
              {d.capacity === 0 ? (
                d.planned > 0 ? (
                  <span className="text-[10px] font-semibold text-red-600" title={`Not working this day, ${d.planned}h planned${title ? `\n${title}` : ''}`}>
                    Off · <span className="font-mono tabular-nums">{d.planned.toFixed(1)}h</span>
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-300 dark:text-slate-600">Off</span>
                )
              ) : viewMode === 'utilization' ? (
                <div className="space-y-1">
                  <div className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold font-mono tabular-nums', getUtilColor(dayUtil))}>
                    {dayUtil}%
                  </div>
                  <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full', dayUtil > 100 ? 'bg-red-500' : dayUtil > 80 ? 'bg-amber-500' : 'bg-blue-500')} style={{ width: getBarWidth(dayUtil) }} />
                  </div>
                </div>
              ) : (
                <div className="text-[11px] font-mono tabular-nums">
                  <span className="font-medium text-slate-700 dark:text-slate-200">{d.planned.toFixed(1)}h</span>
                  <span className="text-slate-400 dark:text-slate-500">/{d.capacity.toFixed(0)}h</span>
                </div>
              )}
            </td>
          );
        })}
        <td className="px-3 py-2.5 text-center font-medium text-slate-700 dark:text-slate-200">
          <span className="font-mono tabular-nums">{p.totals.planned.toFixed(1)}h</span>
          {p.totals.undatedHours > 0 && (
            <p className="text-[10px] font-normal text-slate-400 dark:text-slate-500" title="Hours of tasks with no due date. They are not on any day.">
              +<span className="font-mono tabular-nums">{p.totals.undatedHours.toFixed(1)}h</span> no date
            </p>
          )}
        </td>
        <td className="px-3 py-2.5 text-center text-slate-500 dark:text-slate-400 font-mono tabular-nums">{p.totals.capacity.toFixed(0)}h</td>
        <td className="px-3 py-2.5 text-center text-slate-500 dark:text-slate-400 font-mono tabular-nums" title={p.totals.logged == null ? LOGGED_HIDDEN_TITLE : undefined}>
          {p.totals.logged == null ? '—' : `${p.totals.logged.toFixed(1)}h`}
        </td>
        <td className="px-3 py-2.5 text-center">
          <div className="flex items-center gap-2 justify-center">
            <div className="w-16 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full', util > 100 ? 'bg-red-500' : util > 80 ? 'bg-amber-500' : 'bg-blue-500')}
                style={{ width: getBarWidth(util) }} />
            </div>
            <span className={cn('text-[11px] font-bold font-mono tabular-nums', util > 100 ? 'text-red-600' : 'text-slate-700 dark:text-slate-200')}>
              {util}%
            </span>
          </div>
        </td>
      </tr>
    );
  };

  const colSpan = days.length + 5;

  return (
    <div className="space-y-4">
      {isError && (
        <OpsErrorBanner title="Could not load the team workload" message={opsErrorMessage(error)} onRetry={() => refetch()} />
      )}

      {/* Panel summary — Workload-specific numbers only. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-100">{people.length}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Team Members</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className={cn('text-2xl font-bold', avgUtil > 100 ? 'text-red-600' : avgUtil > 80 ? 'text-amber-600' : 'text-blue-600')}>{avgUtil}%</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Avg Utilization</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className={cn('text-2xl font-bold', overloaded > 0 ? 'text-red-600' : 'text-slate-400 dark:text-slate-500')}>{overloaded}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Overloaded (&gt;100%)</p>
        </div>
        <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-center">
          <p className={cn('text-2xl font-bold', underutil > 0 ? 'text-amber-600' : 'text-slate-400 dark:text-slate-500')}>{underutil}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Under-utilized (&lt;50%)</p>
        </div>
      </div>

      {/* Week navigation + filters */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => data && setWeekOf(shiftDateKey(data.range.from, -7))}
            aria-label="Previous week"
            className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200" data-testid="workload-range">{rangeLabel}</span>
          <button
            type="button"
            onClick={() => data && setWeekOf(shiftDateKey(data.range.from, 7))}
            aria-label="Next week"
            className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          {weekOf && (
            <button type="button" onClick={() => setWeekOf(null)} className="text-[12px] font-semibold text-blue-600 hover:underline">
              This week
            </button>
          )}
          {isFetching && !isLoading && <span className="text-[11px] text-slate-400 dark:text-slate-500">Refreshing…</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={myDeptOnly ? '' : orgUnitId}
            onChange={(e) => setOrgUnitId(e.target.value)}
            disabled={myDeptOnly}
            aria-label="Filter by department"
            title={myDeptOnly ? 'Showing your department ("My department only" is on)' : undefined}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-700 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60"
          >
            <option value="">{myDeptOnly && data?.scope.deptName ? data.scope.deptName : 'All departments'}</option>
            {(data?.orgUnits ?? []).map((u) => (
              <option key={u.id} value={String(u.id)}>{`${'  '.repeat(u.depth ?? 0)}${u.name}`}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={groupByDept}
              onChange={(e) => setGroupByDept(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 text-blue-600"
            />
            <span className="font-medium">Group by department</span>
          </label>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            <button onClick={() => setViewMode('utilization')} className={cn('px-3 py-1 rounded-md text-[12px] font-semibold', viewMode === 'utilization' ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400')}>Utilization %</button>
            <button onClick={() => setViewMode('hours')} className={cn('px-3 py-1 rounded-md text-[12px] font-semibold', viewMode === 'hours' ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400')}>Hours</button>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-2">
        Planned hours (remaining task hours spread over each task's dates) against capacity from work schedules, holidays and absences. Logged hours show only for people you manage.
      </p>

      {/* D3 · Overload Tasks — scheduler-flagged infeasibilities across
          every active project. Sits above the utilization table so a PM
          sees "who is stuck right now" before scanning the week grid. */}
      <OverloadTasksPanel
        onOpenTask={(taskId) => setDrawerTaskId(taskId)}
        onOpenProject={(projectId) => navWithReturn(`/projects/${projectId}`, 'Workload')}
      />

      {/* Utilization Table */}
      <div className="rounded-[14px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-4 py-3 text-left font-semibold w-48">User</th>
              <WorkloadDayHeaders days={days} />
              <th className="px-3 py-3 text-center font-semibold">Planned</th>
              <th className="px-3 py-3 text-center font-semibold">Capacity</th>
              <th className="px-3 py-3 text-center font-semibold">Logged</th>
              <th className="px-3 py-3 text-center font-semibold w-28">Avg Util.</th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 ? (
              <tr><td colSpan={colSpan} className="py-8 text-center text-slate-400 dark:text-slate-500">{isError ? 'Workload could not be loaded' : 'No workload data'}</td></tr>
            ) : groups ? (
              groups.map((g) => {
                const cap = g.people.reduce((s, p) => s + p.totals.capacity, 0);
                const planned = g.people.reduce((s, p) => s + p.totals.planned, 0);
                const pct = utilizationPct(planned, cap);
                return (
                  <Fragment key={g.key}>
                    <tr className="border-t border-slate-200 dark:border-slate-700 bg-[#FAFBFC] dark:bg-slate-800/40">
                      <td colSpan={colSpan} className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-bold text-slate-800 dark:text-slate-100">{g.name}</span>
                          <span className="text-[11px] text-slate-400 dark:text-slate-500"><span className="font-mono tabular-nums">{g.people.length}</span> people</span>
                          <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                            {planned.toFixed(1)}h / {cap.toFixed(0)}h · <span className={cn('font-bold', pct > 100 ? 'text-red-600' : 'text-slate-700 dark:text-slate-200')}>{pct}%</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {g.people.map(renderRow)}
                  </Fragment>
                );
              })
            ) : (
              people.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
