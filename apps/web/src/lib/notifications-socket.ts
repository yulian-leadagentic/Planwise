/**
 * Where the bell's live channel lives on the API: Socket.IO's default
 * engine path and the NotificationsGateway namespace
 * (apps/api/src/modules/notifications/notifications.gateway.ts).
 * The old client used path `/api/ws`, which nothing serves.
 */
export const NOTIFICATIONS_SOCKET_PATH = '/socket.io';
export const NOTIFICATIONS_SOCKET_NAMESPACE = '/notifications';

/** Namespace URL for socket.io-client: the API origin (or the page origin when same-origin) + namespace. */
export function notificationsSocketUrl(apiBase: string, pageOrigin: string): string {
  const origin = (apiBase || pageOrigin).replace(/\/+$/, '');
  return `${origin}${NOTIFICATIONS_SOCKET_NAMESPACE}`;
}

export interface BellNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: number;
  /** Set on mention / reply notifications. */
  messageId?: number;
  /** From GET /notifications: false = no access to the entity itself (only to a thread through a mention). */
  canOpenEntity?: boolean | null;
  /** QA6 (2026-11-26) · an in-app path the server put in `data.link` (e.g. a project's Team tab). */
  link?: string;
  isRead: boolean;
  createdAt: string;
}

/** `data.link` only when it is a path of this app ("/projects/58?…"), never another origin. */
export function inAppLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return undefined;
  }
  return value;
}

/** An API notification row (`readAt`, numeric id) in the bell's shape. */
export function toBellNotification(row: any): BellNotification {
  return {
    id: String(row?.id),
    type: row?.type ?? 'system',
    title: row?.title ?? '',
    body: row?.body ?? '',
    entityType: row?.entityType ?? undefined,
    entityId: row?.entityId ?? undefined,
    messageId: row?.messageId ?? undefined,
    canOpenEntity: row?.canOpenEntity ?? undefined,
    link: inAppLink(row?.data?.link),
    isRead: row?.isRead === true || row?.readAt != null,
    createdAt: row?.createdAt,
  };
}
