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
  isRead: boolean;
  createdAt: string;
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
    isRead: row?.isRead === true || row?.readAt != null,
    createdAt: row?.createdAt,
  };
}
