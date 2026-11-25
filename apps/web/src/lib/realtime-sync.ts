/**
 * QA6 P10 · PR-079 — live task / project updates across tabs.
 *
 * The API's RealtimeGateway (namespace `/realtime`, Socket.IO default
 * path) sends `invalidate` events `{ type, projectId, taskId? }` to the
 * rooms of the projects a tab watches. This module is the pure part:
 * which projects to watch, which React Query keys an event makes stale,
 * and the debounce. The socket wiring is in hooks/use-realtime-sync.ts.
 */

export const REALTIME_SOCKET_PATH = '/socket.io';
export const REALTIME_SOCKET_NAMESPACE = '/realtime';
export const REALTIME_WIRE_EVENT = 'invalidate';

/** Server cap is 50 rooms per socket; stay under it. */
export const MAX_WATCHED_PROJECTS = 40;

export type RealtimeEventType = 'task.updated' | 'task.deleted' | 'project.updated';

export interface RealtimeEvent {
  type: RealtimeEventType;
  projectId: number;
  taskId?: number;
}

const EVENT_TYPES: readonly RealtimeEventType[] = ['task.updated', 'task.deleted', 'project.updated'];

/** Namespace URL: the API origin (or the page origin when same-origin) + `/realtime`. */
export function realtimeSocketUrl(apiBase: string, pageOrigin: string): string {
  const origin = (apiBase || pageOrigin).replace(/\/+$/, '');
  return `${origin}${REALTIME_SOCKET_NAMESPACE}`;
}

function toId(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A well-formed event rebuilt from its ids, or null. */
export function parseRealtimeEvent(raw: unknown): RealtimeEvent | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = r.type as RealtimeEventType;
  if (!EVENT_TYPES.includes(type)) return null;
  const projectId = toId(r.projectId);
  if (projectId === undefined) return null;
  if (type === 'project.updated') return { type, projectId };
  const taskId = toId(r.taskId);
  if (taskId === undefined) return null;
  return { type, projectId, taskId };
}

// ─── Which queries an event makes stale ─────────────────────────────────

/** `projectId` of a task / project payload (`{ data: … }` wrappers unwrapped). */
function projectIdOf(value: unknown, depth = 0): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return undefined;
  const v = value as Record<string, any>;
  const direct = toId(v.projectId) ?? toId(v.project?.id);
  if (direct !== undefined) return direct;
  return projectIdOf(v.data, depth + 1);
}

/** `projectId` of the first filter object in a key (`['tasks', 'list', { projectId }]`). */
function filterProjectId(queryKey: readonly unknown[]): number | undefined {
  for (let i = 1; i < queryKey.length; i++) {
    const part = queryKey[i];
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const id = toId((part as Record<string, unknown>).projectId);
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

/** Task id of a single-task key: `['tasks', 'detail', id, …]` or `['tasks', id, …]`. */
function taskDetailId(queryKey: readonly unknown[]): number | undefined {
  if (queryKey[0] !== 'tasks') return undefined;
  if (queryKey[1] === 'detail') return toId(queryKey[2]);
  return typeof queryKey[1] === 'number' ? toId(queryKey[1]) : undefined;
}

function matchesTasksKey(queryKey: readonly unknown[], data: unknown, event: RealtimeEvent): boolean {
  if (queryKey[1] === 'allowed-transitions') return false; // static per status, not task data
  const detailId = taskDetailId(queryKey);
  if (detailId !== undefined || queryKey[1] === 'detail') {
    if (event.type !== 'project.updated') return detailId === event.taskId;
    // A project-wide change (zone, deliverable target, due-date save)
    // can move any of its tasks: refresh an open task of that project.
    const pid = projectIdOf(data);
    return pid === undefined || pid === event.projectId;
  }
  // Lists: 'list', 'all', 'archived', 'mine', or a params object.
  if (queryKey[1] === 'archived' && typeof queryKey[2] === 'number') return queryKey[2] === event.projectId;
  const scoped = filterProjectId(queryKey);
  return scoped === undefined || scoped === event.projectId;
}

/**
 * True when `queryKey` (with its cached `data`) shows something `event`
 * changed. Keys come from the screens (see lib/query-keys.ts and the
 * inline keys of the planning, kanban, dashboard and workload screens).
 */
export function matchesRealtimeEvent(queryKey: readonly unknown[], data: unknown, event: RealtimeEvent): boolean {
  const [k0, k1, k2] = queryKey;
  const P = event.projectId;
  const isTaskEvent = event.type !== 'project.updated';
  switch (k0) {
    // Task lists, my tasks, task drawer / page, checklist & comments of a task.
    case 'tasks':
      return matchesTasksKey(queryKey, data, event);
    case 'task-attachments':
    case 'task-reviews':
      return isTaskEvent && toId(k1) === event.taskId;
    // Planning grid, kanban, Gantt, Deliverable Planning, project header tiles.
    case 'planning':
    case 'planning-data':
    case 'project-deliverables':
    case 'project-info-summary':
    case 'feasibility':
    case 'progress':
      return k1 === undefined || toId(k1) === P;
    // Execution board: one project, or every project (projectId null).
    case 'execution-board':
      return k1 == null || toId(k1) === P;
    // Operations / manager dashboards aggregate every project.
    case 'dashboard':
      return true;
    // Workload: per project, or across all users.
    case 'workload':
      return k1 === 'project' ? toId(k2) === P : true;
    case 'activity':
      return k1 === 'project' && toId(k2) === P;
    // Project-level only: zones, the project header, the status board.
    case 'zones':
    case 'project-zones':
      return !isTaskEvent && projectIdFromKey(queryKey) === P;
    case 'projects':
      return !isTaskEvent && queryKey.length === 2 && toId(k1) === P;
    case 'project-status-board':
      return !isTaskEvent;
    default:
      return false;
  }
}

export function matchesAnyRealtimeEvent(
  queryKey: readonly unknown[],
  data: unknown,
  events: readonly RealtimeEvent[],
): boolean {
  return events.some((e) => matchesRealtimeEvent(queryKey, data, e));
}

// ─── Which projects this tab watches ────────────────────────────────────

export interface QuerySnapshot {
  queryKey: readonly unknown[];
  data: unknown;
}

/** `/projects/42`, `/projects/42/planning`, `/projects/42/edit` → [42]. */
export function projectIdsFromPath(pathname: string): number[] {
  const m = /^\/projects\/(\d+)(?:\/|$)/.exec(pathname ?? '');
  const id = m ? toId(m[1]) : undefined;
  return id === undefined ? [] : [id];
}

/** The project a query key is about, when the key names one. */
export function projectIdFromKey(queryKey: readonly unknown[]): number | undefined {
  const [k0, k1, k2] = queryKey;
  switch (k0) {
    case 'planning':
    case 'planning-data':
    case 'project-deliverables':
    case 'project-info-summary':
    case 'project-zones':
    case 'project-team':
    case 'feasibility':
    case 'progress':
    case 'execution-board':
    case 'projects':
      return typeof k1 === 'number' ? toId(k1) : undefined;
    case 'activity':
    case 'messages':
    case 'workload':
      return k1 === 'project' ? toId(k2) : undefined;
    case 'zones':
      return k1 === 'tree' || k1 === 'for-task-create' || k1 === 'project' ? toId(k2) : undefined;
    case 'tasks':
      if (k1 === 'archived' && typeof k2 === 'number') return toId(k2);
      return filterProjectId(queryKey);
    default:
      return undefined;
  }
}

/** Rows of a list payload: an array, or `{ data | items | tasks | rows: [...] }`. */
function rowsOf(data: unknown): unknown[] {
  let d: any = data;
  for (let i = 0; i < 3 && d && typeof d === 'object' && !Array.isArray(d); i++) {
    const next = d.data ?? d.items ?? d.tasks ?? d.rows;
    if (next === undefined) break;
    d = next;
  }
  return Array.isArray(d) ? d : [];
}

/** Cross-project lists whose rows say which projects are on screen. */
function isCrossProjectList(queryKey: readonly unknown[]): boolean {
  const [k0, k1] = queryKey;
  if (k0 === 'tasks') return taskDetailId(queryKey) === undefined && k1 !== 'detail' && k1 !== 'allowed-transitions';
  if (k0 === 'execution-board') return k1 == null;
  return k0 === 'dashboard' || (k0 === 'workload' && k1 === 'all-users');
}

/**
 * The projects this tab shows, most specific first: the URL, then
 * queries keyed by a project (a planning modal opened from a list), then
 * open tasks, then the rows of cross-project lists (my tasks, dashboards).
 * Capped at `max` — the rest still refresh when one of these changes.
 */
export function desiredProjectIds(
  pathname: string,
  activeQueries: readonly QuerySnapshot[],
  max = MAX_WATCHED_PROJECTS,
): number[] {
  const ordered: number[] = [...projectIdsFromPath(pathname)];
  for (const q of activeQueries) {
    const id = projectIdFromKey(q.queryKey);
    if (id !== undefined) ordered.push(id);
  }
  for (const q of activeQueries) {
    if (taskDetailId(q.queryKey) === undefined) continue;
    const id = projectIdOf(q.data);
    if (id !== undefined) ordered.push(id);
  }
  for (const q of activeQueries) {
    if (!isCrossProjectList(q.queryKey) || projectIdFromKey(q.queryKey) !== undefined) continue;
    for (const row of rowsOf(q.data)) {
      const id = projectIdOf(row);
      if (id !== undefined) ordered.push(id);
    }
  }
  return [...new Set(ordered)].slice(0, Math.max(0, max));
}

/** Rooms to join and to leave to go from `joined` to `desired`. */
export function roomChanges(joined: ReadonlySet<number>, desired: readonly number[]): { join: number[]; leave: number[] } {
  const want = new Set(desired);
  return {
    join: desired.filter((id) => !joined.has(id)),
    leave: [...joined].filter((id) => !want.has(id)),
  };
}

// ─── Debounce ───────────────────────────────────────────────────────────

export interface InvalidationBatcherOptions {
  /** Flush after this long without a new event. */
  delayMs: number;
  /** …but no later than this long after the first event of the batch. */
  maxWaitMs: number;
  /** While true (e.g. a mutation of this tab is in flight), hold the flush… */
  isBusy?: () => boolean;
  /** …for at most this long past `maxWaitMs`. */
  maxDeferMs?: number;
  onFlush: (events: RealtimeEvent[]) => void;
}

export interface InvalidationBatcher {
  push(event: RealtimeEvent): void;
  /** Flush now (e.g. the tab became visible). */
  flushNow(): void;
  /** Drop everything pending (unmount / sign-out). */
  cancel(): void;
  pendingCount(): number;
}

function eventKey(e: RealtimeEvent): string {
  return `${e.type}:${e.projectId}:${e.taskId ?? ''}`;
}

/**
 * Collects events and flushes them together: a bulk save (one event per
 * task) or a burst from several users becomes ONE invalidation pass.
 * Duplicate events in a batch are kept once.
 */
export function createInvalidationBatcher(opts: InvalidationBatcherOptions): InvalidationBatcher {
  let pending = new Map<string, RealtimeEvent>();
  let firstAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const flushNow = () => {
    clear();
    if (pending.size === 0) return;
    const events = [...pending.values()];
    pending = new Map();
    opts.onFlush(events);
  };

  const onTimer = () => {
    timer = null;
    const age = Date.now() - firstAt;
    if (opts.isBusy?.() && age < opts.maxWaitMs + (opts.maxDeferMs ?? 0)) {
      timer = setTimeout(onTimer, opts.delayMs);
      return;
    }
    flushNow();
  };

  return {
    push(event) {
      if (pending.size === 0) firstAt = Date.now();
      pending.set(eventKey(event), event);
      clear();
      const remaining = opts.maxWaitMs - (Date.now() - firstAt);
      timer = setTimeout(onTimer, Math.max(0, Math.min(opts.delayMs, remaining)));
    },
    flushNow,
    cancel() {
      clear();
      pending = new Map();
    },
    pendingCount: () => pending.size,
  };
}
