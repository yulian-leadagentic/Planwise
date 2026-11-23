/**
 * Permissions round 4 (2026-11-23) — the bell connects where the API's
 * NotificationsGateway listens: Socket.IO default path, `/notifications`
 * namespace. The old client used `/api/ws`, which nothing serves.
 */
import { describe, it, expect } from 'vitest';
import {
  NOTIFICATIONS_SOCKET_PATH,
  NOTIFICATIONS_SOCKET_NAMESPACE,
  notificationsSocketUrl,
  toBellNotification,
} from './notifications-socket';

describe('notification bell socket', () => {
  it('uses the Socket.IO default path and the /notifications namespace', () => {
    expect(NOTIFICATIONS_SOCKET_PATH).toBe('/socket.io');
    expect(NOTIFICATIONS_SOCKET_PATH).not.toBe('/api/ws');
    expect(NOTIFICATIONS_SOCKET_NAMESPACE).toBe('/notifications');
  });

  it('connects to the API origin, or the page origin when the API is same-origin', () => {
    expect(notificationsSocketUrl('https://api.example.app/', 'https://web.example.app')).toBe(
      'https://api.example.app/notifications',
    );
    expect(notificationsSocketUrl('', 'http://localhost:5173')).toBe('http://localhost:5173/notifications');
  });

  it('maps an API notification row to the bell shape', () => {
    expect(
      toBellNotification({ id: 7, type: 'mention', title: 'You were mentioned', body: 'hi', readAt: null, entityType: 'project', entityId: 3, messageId: 40, canOpenEntity: false, createdAt: '2026-11-23T10:00:00Z' }),
    ).toEqual({ id: '7', type: 'mention', title: 'You were mentioned', body: 'hi', entityType: 'project', entityId: 3, messageId: 40, canOpenEntity: false, isRead: false, createdAt: '2026-11-23T10:00:00Z' });
    expect(toBellNotification({ id: 8, readAt: '2026-11-23T11:00:00Z' }).isRead).toBe(true);
  });
});
