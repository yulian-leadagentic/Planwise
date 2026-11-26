import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth.store';
import client from '@/api/client';
import { API_BASE } from '@/lib/runtime-config';
import {
  NOTIFICATIONS_SOCKET_PATH,
  notificationsSocketUrl,
  toBellNotification,
  type BellNotification,
} from '@/lib/notifications-socket';

export type Notification = BellNotification;

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated || !token) return;
    let cancelled = false;

    // Round 4: the history comes from REST (the gateway only pushes new
    // notifications); the socket adds live ones on top. REST rows also
    // carry `canOpenEntity`, so the list is reloaded after each push.
    const loadList = () =>
      client
        .get('/notifications', { params: { perPage: 20 } })
        .then((r) => {
          if (cancelled) return;
          const rows = r.data?.data;
          setNotifications(Array.isArray(rows) ? rows.map(toBellNotification) : []);
          setUnreadCount(Number(r.data?.meta?.unreadCount) || 0);
        })
        .catch(() => {
          /* keep what the bell already shows */
        });
    loadList();

    // Round 4: the gateway is namespace `/notifications` on Socket.IO's
    // default path, at the API origin (the old `/api/ws` path served nothing).
    const socket = io(notificationsSocketUrl(API_BASE, window.location.origin), {
      path: NOTIFICATIONS_SOCKET_PATH,
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('notification', (row: unknown) => {
      const notification = toBellNotification(row);
      setNotifications((prev) => [notification, ...prev.filter((n) => n.id !== notification.id)]);
      if (!notification.isRead) setUnreadCount((prev) => prev + 1);

      // Invalidate relevant queries based on notification type
      if (notification.entityType) {
        queryClient.invalidateQueries({ queryKey: [notification.entityType] });
      }
      // QA6 P4 (PR-063): a task-move request / result refreshes an open
      // Workload board and its "Waiting for my approval" list (the
      // approver may not be in that project's realtime room, D11).
      if (notification.type.startsWith('reassign')) {
        queryClient.invalidateQueries({ queryKey: ['workload'] });
      }
      loadList();
    });

    socketRef.current = socket;

    return () => {
      cancelled = true;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated, token, queryClient]);

  const markRead = useCallback((id: string) => {
    client.patch(`/notifications/${id}/read`).catch(() => {});
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const markAllRead = useCallback(() => {
    client.patch('/notifications/read-all').catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  }, []);

  return { notifications, unreadCount, markRead, markAllRead };
}

export function useMarkRead() {
  const { markRead } = useNotifications();
  return markRead;
}
