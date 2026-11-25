/**
 * QA6 P10 · PR-079 — live task / project updates across tabs.
 *
 * The wire contract is an invalidation hint, never data: the client
 * learns WHICH project (and task) changed and refetches through the
 * normal HTTP routes, which apply every permission and finance rule.
 * Nothing but the ids below ever goes over the socket.
 */

/** Internal EventEmitter2 event the RealtimeGateway listens on. */
export const REALTIME_INVALIDATE = 'realtime.invalidate';

/** Socket.IO event the web receives in a project room. */
export const REALTIME_WIRE_EVENT = 'invalidate';

export const REALTIME_EVENT_TYPES = ['task.updated', 'task.deleted', 'project.updated'] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export interface RealtimeInvalidation {
  type: RealtimeEventType;
  projectId: number;
  taskId?: number;
}

/** A positive integer id (numeric strings accepted), else null. */
export function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Validates an invalidation and rebuilds it from the ids alone, so no
 * extra field a caller attached can reach the wire. Returns null for
 * anything that is not a well-formed event (unknown type, missing or
 * non-positive project id, a task event without a task id).
 */
export function toRealtimeInvalidation(raw: unknown): RealtimeInvalidation | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const type = r.type as RealtimeEventType;
  if (!REALTIME_EVENT_TYPES.includes(type)) return null;
  const projectId = positiveInt(r.projectId);
  if (projectId == null) return null;
  if (type === 'project.updated') return { type, projectId };
  const taskId = positiveInt(r.taskId);
  if (taskId == null) return null;
  return { type, projectId, taskId };
}

/** Socket.IO room of one project in the /realtime namespace. */
export function projectRoom(projectId: number): string {
  return `project-${projectId}`;
}
