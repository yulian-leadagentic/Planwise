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

  // Project rollups. `progress` / `feasibility` are keyed as
  // `[key, projectId]`, so scoping them is a real narrow (skip other
  // projects' caches). `projects` is different: the LIST query is
  // keyed `['projects', paramsObject]`, so the narrow
  // `['projects', projectId]` prefix does NOT match the list — logging
  // time on any project would leave the Projects page showing stale
  // Hours / Cost / Completion (Branch A · fix/project-list-actuals,
  // 2026-08-26). Always invalidate the broad `['projects']` prefix so
  // the list refetches, and layer the per-id key on top when we have it
  // so the detail page's `useProject(id)` also refreshes.
  if (projectId != null) {
    queryClient.invalidateQueries({ queryKey: ['progress', projectId] });
    queryClient.invalidateQueries({ queryKey: ['feasibility', projectId] });
    queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
  } else {
    queryClient.invalidateQueries({ queryKey: ['progress'] });
    queryClient.invalidateQueries({ queryKey: ['feasibility'] });
  }
  queryClient.invalidateQueries({ queryKey: ['projects'] });

  // Planning grid + execution board — both render task rollups computed
  // from the tasks query, but they also cache their own derived views.
  queryClient.invalidateQueries({ queryKey: ['planning'] });
  queryClient.invalidateQueries({ queryKey: ['execution-board'] });
}
