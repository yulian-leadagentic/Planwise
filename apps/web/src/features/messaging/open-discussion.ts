/**
 * Round 4C-2 (2026-11-23): where a click on an Inbox item or a bell
 * notification goes. A user mentioned in a thread of a project he has
 * no access to can't open the project page, so he gets the entity's
 * discussion in the DiscussionDrawer (the API lists only the threads he
 * is mentioned in).
 */

export type DiscussionEntityType = 'project' | 'task' | 'zone';

export interface DiscussionTarget {
  entityType: DiscussionEntityType;
  entityId: number;
}

export type OpenAction =
  | { kind: 'navigate'; to: string }
  | { kind: 'drawer'; target: DiscussionTarget };

const DISCUSSION_ENTITY_TYPES: readonly string[] = ['project', 'task', 'zone'];

function discussionTarget(entityType: unknown, entityId: unknown): DiscussionTarget | null {
  const id = Number(entityId);
  if (typeof entityType !== 'string' || !DISCUSSION_ENTITY_TYPES.includes(entityType)) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  return { entityType: entityType as DiscussionEntityType, entityId: id };
}

/** The Inbox's existing entity link. */
export function inboxEntityLink(msg: { entityType?: string; entityId?: number }): string {
  if (msg.entityType === 'project') return `/projects/${msg.entityId}`;
  if (msg.entityType === 'task') return `/projects`; // task detail if exists
  return '#';
}

/** Inbox item: the entity page when he may open it, else the discussion drawer. */
export function inboxItemAction(msg: { entityType?: string; entityId?: number; canOpenEntity?: boolean }): OpenAction {
  const target = discussionTarget(msg.entityType, msg.entityId);
  if (msg.canOpenEntity === false && target) return { kind: 'drawer', target };
  return { kind: 'navigate', to: inboxEntityLink(msg) };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * QA6 P4 (PR-063): a task-move notification (`reassign_request` to the
 * approver, `reassign_result` to the requester, `reassign_removed` to the
 * person the task left; all `entityType: 'task_reassignment'`) opens
 * Operations › Workload on the week of the move: `data.toDay`, else
 * `data.fromDay` / `data.weekOf` (any date of that week; the API's
 * `weekOf` takes it).
 */
export function workloadNotificationLink(n: { type?: string; entityType?: string; data?: unknown }): string | null {
  const isMove = (typeof n.type === 'string' && n.type.startsWith('reassign')) || n.entityType === 'task_reassignment';
  if (!isMove) return null;
  const data = (n.data && typeof n.data === 'object' ? n.data : {}) as Record<string, unknown>;
  const day = [data.toDay, data.fromDay, data.weekOf].find((v): v is string => typeof v === 'string' && YMD.test(v));
  const params = new URLSearchParams({ tab: 'workload' });
  if (day) params.set('weekOf', day);
  if (n.type === 'reassign_request') params.set('approvals', '1');
  return `/operations?${params.toString()}`;
}

/** Bell item: a mention / reply he can't open as a page → the drawer; otherwise as before. */
export function notificationClickAction(n: {
  type?: string;
  entityType?: string;
  entityId?: number;
  messageId?: number;
  canOpenEntity?: boolean | null;
  /** QA6 (2026-11-26) · in-app path from the notification's `data.link` (already checked by `inAppLink`). */
  link?: string;
  data?: unknown;
}): OpenAction {
  const workload = workloadNotificationLink(n);
  if (workload) return { kind: 'navigate', to: workload };
  const target = discussionTarget(n.entityType, n.entityId);
  if (n.canOpenEntity === false && n.messageId != null && target) return { kind: 'drawer', target };
  // E.g. a "join the team" request opens the project's Team tab.
  if (n.link) return { kind: 'navigate', to: n.link };
  if (n.entityType === 'project' && n.entityId) return { kind: 'navigate', to: `/projects/${n.entityId}` };
  if (n.entityType === 'task' && n.entityId) return { kind: 'navigate', to: '/projects' };
  return { kind: 'navigate', to: '/inbox' };
}
