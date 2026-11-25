/**
 * Planning tab task filters: the pure predicate behind the grid.
 *
 * Extracted from planning-modal.tsx (QA6 PR-068) so the filter can be
 * unit-tested without React. PlanningView runs every task through
 * `taskPassesPlanningFilters` ONCE, before sorting and grouping; every
 * grouping mode (Zone, Deliverable, Service, None, and the nested
 * sub-groups) is built from that already-filtered list. That is why a
 * Service filter hides other services' tasks in every grouping mode, and
 * why a zone / deliverable left with no tasks behaves exactly as it does
 * for the Status or Assignee filters.
 *
 * No React imports here on purpose.
 */
import {
  resolveTaskDeliverable,
  type ProjectDeliverableLookups,
} from '@/features/planning/resolve-task-deliverable';

// ─── Persisted filter shapes ────────────────────────────────────────────────

/** Per-column funnel filters (Y1). Empty string = no filter. */
export interface ColFilters {
  code: string;
  name: string;
  zone: string;
  deliverable: string;
  /** Resolved Service name, or EMPTY_BUCKET for tasks with none. Shared by
   *  the Service column funnel and the "Service" field in Task Filters
   *  (PR-068), so the two controls can never disagree. */
  service: string;
  status: string;
  assignee: string; // user id as string
}

// #5 · persisted Planning-tab filter block.
//
// Combined shape stored under
// `planwise:project:<projectId>:planning-filters`. Keeps the main
// "Filters" popover (status / priority / assignee / date / has-due /
// service) alongside the per-column funnels (`col`) so one localStorage
// write covers both, and the user sees exactly the view they left behind
// after switching tabs. Field names stay plain and JSON-serialisable
// (no Map / Set / Date) so the hook's try/catch read is bulletproof.
export interface PlanningTabFilters {
  status: string;
  priority: string;
  assigneeIds: number[];
  startFrom: string;
  startTo: string;
  dueFrom: string;
  dueTo: string;
  hasDue: '' | 'yes' | 'no';
  col: ColFilters;
}

export const EMPTY_COL_FILTERS: ColFilters = {
  code: '', name: '', zone: '', deliverable: '', service: '', status: '', assignee: '',
};

export const PLANNING_FILTERS_DEFAULT: PlanningTabFilters = {
  status: '',
  priority: '',
  assigneeIds: [],
  startFrom: '',
  startTo: '',
  dueFrom: '',
  dueTo: '',
  hasDue: '',
  col: EMPTY_COL_FILTERS,
};

/** Bucket value for "no Service" / "no Deliverable" in the select filters. */
export const EMPTY_BUCKET = '(empty)';

// ─── Service resolution ─────────────────────────────────────────────────────

/**
 * Resolve the SERVICE column value for a project task. Read-time
 * fallback chain — many project tasks have `task.phaseId = NULL`
 * because applyProjectTemplate didn't consistently propagate the source
 * template's phase onto the created task. Walk every source of truth:
 *
 *   0. task.service                                   (server-resolved, includes
 *                                                      the marker→template JOIN)
 *   1. task.phase                                     (direct FK, editable)
 *   2. task.projectDeliverable.service                (parent deliverable's service)
 *   3. task.deliverableTemplate.phase                 (source template's phase)
 *   4. projectDeliverable(byId).service               (via lookups)
 *   5. projectDeliverable(byTemplateId).service       (via lookups)
 *
 * Returns `{ name, color }` or nulls when nothing resolves.
 */
export function resolveTaskService(
  t: any,
  lookups?: ProjectDeliverableLookups,
): { name: string | null; color: string | null } {
  // Server-resolved service (planning.service.ts walks the full chain,
  // including a marker→template.name JOIN for legacy inline zone-tasks
  // that have no deliverableTemplateId FK). Preferred over any local
  // fallback because it has DB access to the templates table.
  if (t.service?.name) {
    return { name: t.service.name, color: t.service.color ?? null };
  }
  if (t.phase?.name) {
    return { name: t.phase.name, color: t.phase.color ?? null };
  }
  // Direct on the task payload (planning-data endpoint includes these
  // relations for exactly this fallback — see planning.service.ts).
  if (t.projectDeliverable?.service?.name) {
    return {
      name: t.projectDeliverable.service.name,
      color: t.projectDeliverable.service.color ?? null,
    };
  }
  if (t.deliverableTemplate?.phase?.name) {
    return {
      name: t.deliverableTemplate.phase.name,
      color: t.deliverableTemplate.phase.color ?? null,
    };
  }
  // Fall through to the context lookups (used by callers that don't
  // have the include, e.g. the group-header aggregation path).
  if (lookups) {
    if (t.projectDeliverableId != null) {
      const d = lookups.byId.get(t.projectDeliverableId);
      if (d?.service?.name) return { name: d.service.name, color: d.service.color ?? null };
    }
    if (t.deliverableTemplateId != null) {
      const d = lookups.byTemplateId.get(t.deliverableTemplateId);
      if (d?.service?.name) return { name: d.service.name, color: d.service.color ?? null };
    }
  }
  return { name: null, color: null };
}

/** The value a task carries for the Service filter: the same name the
 *  SERVICE column shows, or EMPTY_BUCKET when nothing resolves. */
export function taskServiceFilterValue(t: any, lookups?: ProjectDeliverableLookups): string {
  return resolveTaskService(t, lookups).name ?? EMPTY_BUCKET;
}

/** Distinct Service filter options for a task list, sorted, with the
 *  EMPTY_BUCKET entry included when any task has no service. */
export function serviceFilterOptions(tasks: any[], lookups?: ProjectDeliverableLookups): string[] {
  const set = new Set<string>();
  for (const t of tasks) set.add(taskServiceFilterValue(t, lookups));
  return Array.from(set).sort();
}

// ─── Per-column predicate ───────────────────────────────────────────────────

export const COL_FILTER_KEYS: ReadonlyArray<keyof ColFilters> = [
  'code', 'name', 'zone', 'deliverable', 'service', 'status', 'assignee',
];

/**
 * Does `t` pass the column filter `col` = `value`? Empty value = pass.
 * Text columns substring-match; select columns exact-match on the SAME
 * resolved value the column renders (QA4 Wave-2 PG-1).
 */
export function taskPassesColFilter(
  t: any,
  col: keyof ColFilters,
  value: string,
  lookups?: ProjectDeliverableLookups,
): boolean {
  if (!value) return true;
  switch (col) {
    case 'code':
      return !!t.code && String(t.code).toLowerCase().includes(value.toLowerCase());
    case 'name':
      return !!t.name && String(t.name).toLowerCase().includes(value.toLowerCase());
    case 'zone':
      return (t.zone?.name ?? 'Project Root') === value;
    case 'deliverable': {
      // QA4 B2: '(empty)' bucket — tasks that resolve to 'No Deliverable'.
      const resolved = resolveTaskDeliverable(t, lookups);
      return (resolved === 'No Deliverable' ? EMPTY_BUCKET : resolved) === value;
    }
    case 'service':
      return taskServiceFilterValue(t, lookups) === value;
    case 'status':
      return t.status === value;
    case 'assignee': {
      const aid = Number(value);
      return Array.isArray(t.assignees)
        && t.assignees.some((a: any) => a.userId === aid || a.user?.id === aid);
    }
    default:
      return true;
  }
}

// ─── Full predicate ─────────────────────────────────────────────────────────

/**
 * Every Planning filter in one place: free-text search, the Task Filters
 * popover (status / priority / assignees / date ranges / has-due) and the
 * per-column funnels, including Service.
 */
export function taskPassesPlanningFilters(
  t: any,
  filters: PlanningTabFilters,
  search: string,
  lookups?: ProjectDeliverableLookups,
): boolean {
  const q = search.trim().toLowerCase();
  // Free-text search (code / name / zone / service)
  if (q) {
    const hit =
      t.code?.toLowerCase().includes(q) ||
      t.name?.toLowerCase().includes(q) ||
      t.zone?.name?.toLowerCase().includes(q) ||
      t.serviceType?.name?.toLowerCase().includes(q);
    if (!hit) return false;
  }
  // Status (must be exact enum match if set)
  if (filters.status && t.status !== filters.status) return false;
  // Priority (must be exact enum match if set) — V7
  if (filters.priority && t.priority !== filters.priority) return false;
  // Assignee — match if ANY of the selected people is on the task.
  // UNION semantics matches the chip stack the user sees. Empty
  // set = no assignee filter.
  if (filters.assigneeIds.length > 0) {
    const filterSet = new Set(filters.assigneeIds);
    const hasAssignee = Array.isArray(t.assignees)
      && t.assignees.some((a: any) => {
        const aid: number | undefined = a.userId ?? a.user?.id;
        return typeof aid === 'number' && filterSet.has(aid);
      });
    if (!hasAssignee) return false;
  }
  // Estimated-start range — uses the planning field, NOT actual startDate.
  const ts = t.estimatedStartDate ? String(t.estimatedStartDate).slice(0, 10) : '';
  if (filters.startFrom && (!ts || ts < filters.startFrom)) return false;
  if (filters.startTo && (!ts || ts > filters.startTo)) return false;
  // Due-date range
  const td = t.endDate ? String(t.endDate).slice(0, 10) : '';
  if (filters.dueFrom && (!td || td < filters.dueFrom)) return false;
  if (filters.dueTo && (!td || td > filters.dueTo)) return false;
  // Has-due-date filter (yes/no/any)
  if (filters.hasDue === 'yes' && !td) return false;
  if (filters.hasDue === 'no' && td) return false;

  // Y1 — per-column funnel filters (Service included, PR-068).
  for (const col of COL_FILTER_KEYS) {
    if (!taskPassesColFilter(t, col, filters.col[col], lookups)) return false;
  }
  return true;
}
