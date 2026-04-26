import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth.store';

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: number;
  isRead: boolean;
  createdAt: string;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated || !token) return;

    // Use VITE_API_URL when API is on a different host (e.g. Railway split
     // services); fall back to the page origin for nginx-proxied dev/prod.
    const apiOrigin = (import.meta.env.VITE_API_URL?.trim() || window.location.origin).replace(/\/$/, '');
    const socket = io(apiOrigin, {
      path: '/api/ws',
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      socket.emit('notifications:subscribe');
    });

    socket.on('notification', (notification: Notification) => {
      setNotifications((prev) => [notification, ...prev]);
      setUnreadCount((prev) => prev + 1);

      // Invalidate relevant queries based on notification type
      if (notification.entityType) {
        queryClient.invalidateQueries({ queryKey: [notification.entityType] });
      }
    });

    socket.on('notifications:initial', (data: { notifications: Notification[]; unreadCount: number }) => {
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated, token, queryClient]);

  const markRead = useCallback((id: string) => {
    socketRef.current?.emit('notifications:read', { id });
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const markAllRead = useCallback(() => {
    socketRef.current?.emit('notifications:read-all');
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  }, []);

  return { notifications, unreadCount, markRead, markAllRead };
}

export function useMarkRead() {
  const { markRead } = useNotifications();
  return markRead;
}
