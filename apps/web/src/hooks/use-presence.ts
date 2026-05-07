import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '@/api/client';

/**
 * Live presence on a project page. Sends a heartbeat every 20s while
 * mounted and polls the active-users list every 10s. Returns the list of
 * other users currently on this project (the caller is filtered out).
 *
 * Intentionally simple HTTP polling instead of a WebSocket: heartbeat
 * traffic is tiny (a no-op POST) and the list lag is fine for a "who's
 * here right now" indicator.
 */
export type PresenceUser = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
};

export function useProjectPresence(projectId: number, currentUserId?: number) {
  const queryClient = useQueryClient();

  // Heartbeat — fire-and-forget POST so the server keeps us in its
  // "active" set. Run immediately on mount, then every 20s. The server
  // TTL is 60s so missing one is safe.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const beat = () => {
      if (cancelled) return;
      client.post('/presence/heartbeat', { projectId }).catch(() => {/* ignore */});
    };
    beat();
    const id = window.setInterval(beat, 20_000);

    // Try to send a "leave" beacon on unload. sendBeacon is fire-and-forget
    // and survives the unload event better than fetch.
    const handleUnload = () => {
      try {
        const url = `${client.defaults.baseURL ?? ''}/presence/leave`;
        const data = new Blob([JSON.stringify({ projectId })], { type: 'application/json' });
        navigator.sendBeacon?.(url, data);
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('beforeunload', handleUnload);
      // Tell the server we left so other viewers update faster than the
      // server sweep would on its own.
      client.post('/presence/leave', { projectId }).catch(() => {});
      // Drop the cached list immediately so the indicator clears.
      queryClient.removeQueries({ queryKey: ['presence', projectId] });
    };
  }, [projectId, queryClient]);

  const query = useQuery<PresenceUser[]>({
    queryKey: ['presence', projectId],
    queryFn: () => client.get(`/presence/project/${projectId}`).then((r) => {
      const d = r.data?.data ?? r.data;
      return Array.isArray(d) ? d : d?.data ?? [];
    }),
    enabled: !!projectId,
    refetchInterval: 10_000,
    staleTime: 0,
  });

  const others = (query.data ?? []).filter((u) => u.id !== currentUserId);
  return { others, isLoading: query.isLoading };
}
