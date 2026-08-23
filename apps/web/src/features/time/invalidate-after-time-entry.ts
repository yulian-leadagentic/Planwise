import type { QueryClient } from '@tanstack/react-query';

/**
 * Shared invalidator for every time-entry mutation (create / update / delete).
 *
 * Why: logging time changes actuals that the server rolls up LIVE
 * (`execution-planning.service#getProjectProgress`,
 * `#calculateFeasibility`) and also updates `task.completionPct` via
 * `time-entries.service#syncTaskCompletion`. Previously each mutation
 * site invalidated a different, narrower slice — so the Time-screen
 * form left the project Hours / task Actual ₪ / completion % stale
 * until a manual refresh, while the weekly timesheet happened to
 * refresh some of them. Routing every mutation through this helper
 * keeps the invalidations consistent and prevents the drift.
 *
 * Query keys are prefix-matched by react-query, so passing the parent
 * key (`['tasks']`, `['planning']`, `['progress']`, …) invalidates
 * every child query too. When `projectId` isn't in scope (delete-by-id
 * or hook-level calls with no context), we invalidate the whole
 * `['progress']` / `['feasibility']` / `['projects']` prefixes — a bit
 * broader than strictly needed, but the alternative is stale KPIs.
 */
export function invalidateAfterTimeEntry(
  queryClient: QueryClient,
  opts: { projectId?: number | null; taskId?: number | null } = {},
): void {
  const { projectId, taskId } = opts;

  // Time entries themselves — lists, weekly grid, daily breakdown, per-task.
  queryClient.invalidateQueries({ queryKey: ['time'] });

  // Task lists + per-task detail. syncTaskCompletion writes completionPct
  // and (via cascading tasks queries) the actual-hours / actual-₪ read by
  // the planning grid and kanban.
  queryClient.invalidateQueries({ queryKey: ['tasks'] });
  if (taskId != null) {
    queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
  }

  // Project rollups. Prefer scoped invalidation when we know the project;
  // fall back to the whole prefix when we don't (delete-by-id path).
  if (projectId != null) {
    queryClient.invalidateQueries({ queryKey: ['progress', projectId] });
    queryClient.invalidateQueries({ queryKey: ['feasibility', projectId] });
    queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
  } else {
    queryClient.invalidateQueries({ queryKey: ['progress'] });
    queryClient.invalidateQueries({ queryKey: ['feasibility'] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
  }

  // Planning grid + execution board — both render task rollups computed
  // from the tasks query, but they also cache their own derived views.
  queryClient.invalidateQueries({ queryKey: ['planning'] });
  queryClient.invalidateQueries({ queryKey: ['execution-board'] });
}
