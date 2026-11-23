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

/** Bell item: a mention / reply he can't open as a page → the drawer; otherwise as before. */
export function notificationClickAction(n: {
  entityType?: string;
  entityId?: number;
  messageId?: number;
  canOpenEntity?: boolean | null;
}): OpenAction {
  const target = discussionTarget(n.entityType, n.entityId);
  if (n.canOpenEntity === false && n.messageId != null && target) return { kind: 'drawer', target };
  if (n.entityType === 'project' && n.entityId) return { kind: 'navigate', to: `/projects/${n.entityId}` };
  if (n.entityType === 'task' && n.entityId) return { kind: 'navigate', to: '/projects' };
  return { kind: 'navigate', to: '/inbox' };
}
