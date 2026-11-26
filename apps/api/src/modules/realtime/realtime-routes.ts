import type { RealtimeEventType } from './realtime.events';

/**
 * Which HTTP writes announce a change, and where the project / task ids
 * come from.
 *
 * Why a route table (and not an emit in each service): only two domain
 * events exist today (`task.status.changed`, `task.assignee.added`,
 * bridged in realtime-events.listener.ts). Task create / update / delete
 * / restore, the planning bulk saves, zones, deliverables, targets and
 * due-date saves have none, and tasks.service.ts is being changed by
 * another package in parallel. One interceptor after a SUCCESSFUL write
 * covers all of them without touching a service, and a bulk save is one
 * request, so it announces once.
 *
 * Keys are `<METHOD> <controller path>/<handler path>` exactly as the
 * Nest decorators spell them (no `api/v1` prefix);
 * realtime-routes.spec.ts fails when a key no longer matches a route.
 */

export type RealtimeTargetSource =
  /** `:param` is a task id. */
  | { kind: 'task'; param: string }
  /** The created task in the response (`id`, `projectId`). */
  | { kind: 'createdTask' }
  /** `:param` is a task checklist item id. */
  | { kind: 'checklistItem'; param: string }
  /** `:param` is a task attachment id. */
  | { kind: 'attachment'; param: string }
  /** `:param` is a zone id. */
  | { kind: 'zone'; param: string }
  /** `:param` is a project-deliverable id. */
  | { kind: 'deliverable'; param: string }
  /** `:param` is the project id. */
  | { kind: 'project'; param: string }
  /** `body.projectId` (falls back to the response's `projectId`). */
  | { kind: 'bodyProject' }
  /** `body.items[].id` — task, zone or deliverable ids of a bulk save. */
  | { kind: 'bodyItems'; entity: 'task' | 'zone' | 'deliverable' };

export interface RealtimeRouteRule {
  type: RealtimeEventType;
  source: RealtimeTargetSource;
  /**
   * Resolve the ids BEFORE the handler runs: the row is deleted
   * afterwards (DELETE routes), or may move to another project (a task
   * PATCH that carries `projectId`). A function decides per request.
   */
  before?: boolean | ((body: any) => boolean);
  /** Resolve AFTER the handler too (default true; false for DELETE). */
  after?: boolean;
}

const task = (param = 'id'): RealtimeTargetSource => ({ kind: 'task', param });
const zone = (param = 'id'): RealtimeTargetSource => ({ kind: 'zone', param });
const deliverable = (param = 'id'): RealtimeTargetSource => ({ kind: 'deliverable', param });
const project = (param = 'id'): RealtimeTargetSource => ({ kind: 'project', param });

const TASK_UPDATED = (source: RealtimeTargetSource): RealtimeRouteRule => ({ type: 'task.updated', source });
const PROJECT_UPDATED = (source: RealtimeTargetSource): RealtimeRouteRule => ({ type: 'project.updated', source });
const DELETED_ROW = (rule: RealtimeRouteRule): RealtimeRouteRule => ({ ...rule, before: true, after: false });

export const REALTIME_ROUTES: Readonly<Record<string, RealtimeRouteRule>> = {
  // ─── Tasks (task drawer, kanban, my tasks, planning grid) ──────────
  'POST tasks': TASK_UPDATED({ kind: 'createdTask' }),
  'PATCH tasks/:id': {
    ...TASK_UPDATED(task()),
    // Moving a task to another project: the old project's room hears it too.
    before: (body) => body != null && typeof body === 'object' && 'projectId' in body,
  },
  'DELETE tasks/:id': DELETED_ROW({ type: 'task.deleted', source: task() }),
  'POST tasks/:id/restore': TASK_UPDATED(task()),
  'POST tasks/:id/review': TASK_UPDATED(task()),
  'POST tasks/:id/assignees': TASK_UPDATED(task()),
  'DELETE tasks/:id/assignees/:userId': TASK_UPDATED(task()),
  // QA6 PR-063 — Workload drag-and-drop (WorkloadAssignController). The
  // /workload/reassignments/:id/* routes have no task param: the service
  // emits REALTIME_INVALIDATE itself after approve / reject / undo.
  'POST tasks/:id/reassign': TASK_UPDATED(task()),
  'POST tasks/:id/checklist': TASK_UPDATED(task()),
  'PATCH tasks/checklist/:itemId': TASK_UPDATED({ kind: 'checklistItem', param: 'itemId' }),
  'DELETE tasks/checklist/:itemId': DELETED_ROW(TASK_UPDATED({ kind: 'checklistItem', param: 'itemId' })),
  'POST tasks/:id/comments': TASK_UPDATED(task()),
  'POST tasks/:id/attachments': TASK_UPDATED(task()),
  'DELETE tasks/attachments/:attachmentId': DELETED_ROW(TASK_UPDATED({ kind: 'attachment', param: 'attachmentId' })),
  'POST tasks/reorder': PROJECT_UPDATED({ kind: 'bodyItems', entity: 'task' }),
  // Predecessors (planning grid / Gantt).
  'POST projects/tasks/:taskId/dependencies': TASK_UPDATED(task('taskId')),
  'PATCH projects/tasks/:taskId/dependencies/:dependsOnId': TASK_UPDATED(task('taskId')),
  'DELETE projects/tasks/:taskId/dependencies/:dependsOnId': TASK_UPDATED(task('taskId')),
  // Deliverable Planning "overwrite manual date" and the Executive Review note.
  'POST project-deliverables/tasks/:taskId/force-apply-target': TASK_UPDATED(task('taskId')),
  'POST dashboard/operations/tasks/:taskId/ops-note': TASK_UPDATED(task('taskId')),

  // ─── Project-level planning data ───────────────────────────────────
  'PATCH projects/:id': PROJECT_UPDATED(project()),
  'DELETE projects/:id': PROJECT_UPDATED(project()),
  'POST projects/:id/close': PROJECT_UPDATED(project()),
  'POST projects/:id/reopen': PROJECT_UPDATED(project()),
  'PATCH projects/:id/leader': PROJECT_UPDATED(project()),
  // Zones (and the templates applied into them, which create tasks).
  'POST zones': PROJECT_UPDATED({ kind: 'bodyProject' }),
  'PATCH zones/:id': PROJECT_UPDATED(zone()),
  'DELETE zones/:id': PROJECT_UPDATED(zone()),
  'POST zones/:id/copy-structure': PROJECT_UPDATED(zone()),
  'POST zones/:id/explode-typical': PROJECT_UPDATED(zone()),
  'POST zones/:id/apply-task-template': PROJECT_UPDATED(zone()),
  'POST zones/:id/duplicate': PROJECT_UPDATED(zone()),
  'POST zones/apply-task-template': PROJECT_UPDATED({ kind: 'bodyProject' }),
  'POST zones/apply-project-template': PROJECT_UPDATED({ kind: 'bodyProject' }),
  'POST zones/reorder': PROJECT_UPDATED({ kind: 'bodyItems', entity: 'zone' }),
  // Deliverables and their planning targets (targets propagate to task due dates).
  'POST project-deliverables': PROJECT_UPDATED({ kind: 'bodyProject' }),
  'POST project-deliverables/reorder': PROJECT_UPDATED({ kind: 'bodyItems', entity: 'deliverable' }),
  'PATCH project-deliverables/:id': PROJECT_UPDATED(deliverable()),
  'PATCH project-deliverables/:id/target': PROJECT_UPDATED(deliverable()),
  'POST project-deliverables/targets/batch': PROJECT_UPDATED({ kind: 'bodyItems', entity: 'deliverable' }),
  'DELETE project-deliverables/:id': PROJECT_UPDATED(deliverable()),
  // Due-date saves of the Deliverable Planning tab.
  'POST scheduling/projects/:projectId/save-and-update-due-dates': PROJECT_UPDATED(project('projectId')),
  'POST scheduling/projects/:projectId/apply-reviewed': PROJECT_UPDATED(project('projectId')),
  // Project status board cell.
  'POST project-status-board/toggle/:projectId/:milestoneId': PROJECT_UPDATED(project('projectId')),
};

function trimSlashes(path: unknown): string {
  return String(path ?? '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

/** `POST` + `tasks` + `:id/restore` → `POST tasks/:id/restore`. */
export function realtimeRouteKey(method: string, controllerPath: unknown, handlerPath: unknown): string {
  const path = [trimSlashes(controllerPath), trimSlashes(handlerPath)].filter(Boolean).join('/');
  return `${String(method).toUpperCase()} ${path}`;
}

export function shouldResolveBefore(rule: RealtimeRouteRule, body: unknown): boolean {
  return typeof rule.before === 'function' ? rule.before(body) : rule.before === true;
}

export function shouldResolveAfter(rule: RealtimeRouteRule): boolean {
  return rule.after !== false;
}
