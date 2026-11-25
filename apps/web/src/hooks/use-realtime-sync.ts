import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';

import { useAuthStore } from '@/stores/auth.store';
import { API_BASE } from '@/lib/runtime-config';
import {
  REALTIME_SOCKET_PATH,
  REALTIME_WIRE_EVENT,
  MAX_WATCHED_PROJECTS,
  createInvalidationBatcher,
  desiredProjectIds,
  matchesAnyRealtimeEvent,
  parseRealtimeEvent,
  realtimeSocketUrl,
  roomChanges,
  type RealtimeEvent,
} from '@/lib/realtime-sync';

/** Quiet period before a batch of events is applied (bulk saves arrive as a burst). */
const DEBOUNCE_MS = 400;
/** A steady stream still refreshes at least this often. */
const MAX_WAIT_MS = 2000;
/** How long a mutation in flight in this tab may hold the refresh back. */
const MAX_DEFER_MS = 5000;
/** Rooms are recomputed this long after the visible queries change. */
const ROOMS_RECOMPUTE_MS = 300;
/** The server refused the handshake (expired token): retry with backoff. */
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60000;

/**
 * QA6 P10 · PR-079 — live task / project updates across tabs. Mounted
 * once, in AppShell.
 *
 * Opens the `/realtime` socket, joins the rooms of the projects this tab
 * shows (URL + the active React Query queries, see desiredProjectIds),
 * and on `invalidate` events marks the matching queries stale
 * (matchesRealtimeEvent) after a short debounce. A hidden tab only marks
 * them and refetches when it becomes visible again. After a reconnect
 * the watched projects are refreshed once, since events sent while
 * offline are lost.
 */
export function useRealtimeSync(): void {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { pathname } = useLocation();
  const pathnameRef = useRef(pathname);
  const scheduleRecomputeRef = useRef<() => void>(() => {});

  useEffect(() => {
    pathnameRef.current = pathname;
    scheduleRecomputeRef.current();
  }, [pathname]);

  useEffect(() => {
    if (!isAuthenticated) return;

    let disposed = false;
    let joined = new Set<number>();
    const refused = new Set<number>();
    let watched: number[] = [];
    let everConnected = false;
    let staleWhileHidden = false;
    let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = RETRY_MIN_MS;

    const isHidden = () => document.visibilityState === 'hidden';

    const applyEvents = (events: RealtimeEvent[]) => {
      const hidden = isHidden();
      void queryClient.invalidateQueries({
        predicate: (query) => matchesAnyRealtimeEvent(query.queryKey, query.state.data, events),
        refetchType: hidden ? 'none' : 'active',
      });
      if (hidden) staleWhileHidden = true;
    };

    const batcher = createInvalidationBatcher({
      delayMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
      maxDeferMs: MAX_DEFER_MS,
      isBusy: () => queryClient.isMutating() > 0,
      onFlush: applyEvents,
    });

    const socket = io(realtimeSocketUrl(API_BASE, window.location.origin), {
      path: REALTIME_SOCKET_PATH,
      // Read at every (re)connect, so a refreshed token is picked up
      // without tearing the socket down.
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken ?? '' }),
      transports: ['websocket', 'polling'],
    });

    const syncRooms = () => {
      if (!socket.connected) return;
      const { join, leave } = roomChanges(joined, watched);
      for (const projectId of leave) {
        joined.delete(projectId);
        socket.emit('project:leave', { projectId });
      }
      for (const projectId of join) {
        joined.add(projectId);
        socket.emit('project:join', { projectId }, (ack?: { ok?: boolean }) => {
          if (ack?.ok) return;
          // No access (or over the cap): don't ask again until reconnect.
          joined.delete(projectId);
          refused.add(projectId);
        });
      }
    };

    const recompute = () => {
      const active = queryClient
        .getQueryCache()
        .getAll()
        .filter((query) => query.getObserversCount() > 0)
        .map((query) => ({ queryKey: query.queryKey, data: query.state.data }));
      watched = desiredProjectIds(pathnameRef.current, active, MAX_WATCHED_PROJECTS + refused.size)
        .filter((id) => !refused.has(id))
        .slice(0, MAX_WATCHED_PROJECTS);
      syncRooms();
    };

    const scheduleRecompute = () => {
      if (disposed || recomputeTimer) return;
      recomputeTimer = setTimeout(() => {
        recomputeTimer = null;
        if (!disposed) recompute();
      }, ROOMS_RECOMPUTE_MS);
    };
    scheduleRecomputeRef.current = scheduleRecompute;

    socket.on('connect', () => {
      retryDelay = RETRY_MIN_MS;
      joined = new Set(); // a new server-side socket has no rooms
      refused.clear();
      recompute();
      if (everConnected) {
        for (const projectId of watched) batcher.push({ type: 'project.updated', projectId });
      }
      everConnected = true;
    });

    socket.on('disconnect', (reason) => {
      joined = new Set();
      // Socket.IO reconnects by itself after a network drop, but not
      // after the server closed the socket (handshake refused).
      if (reason === 'io server disconnect' && !disposed) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!disposed && !socket.connected) socket.connect();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      }
    });

    socket.on(REALTIME_WIRE_EVENT, (raw: unknown) => {
      const event = parseRealtimeEvent(raw);
      if (event) batcher.push(event);
    });

    // A refreshed access token lets a refused socket try again at once.
    const unsubscribeAuth = useAuthStore.subscribe((state, prev) => {
      if (disposed || socket.connected || !state.accessToken || state.accessToken === prev.accessToken) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      socket.connect();
    });

    // The visible queries decide which project rooms to be in.
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'observerAdded' ||
        event.type === 'observerRemoved' ||
        (event.type === 'updated' && event.action.type === 'success')
      ) {
        scheduleRecompute();
      }
    });

    const onVisibilityChange = () => {
      if (isHidden()) return;
      batcher.flushNow();
      if (staleWhileHidden) {
        staleWhileHidden = false;
        void queryClient.refetchQueries({
          type: 'active',
          predicate: (query) => query.state.isInvalidated && query.state.fetchStatus === 'idle',
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    scheduleRecompute();

    return () => {
      disposed = true;
      scheduleRecomputeRef.current = () => {};
      batcher.cancel();
      if (recomputeTimer) clearTimeout(recomputeTimer);
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeCache();
      unsubscribeAuth();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [isAuthenticated, queryClient]);
}
