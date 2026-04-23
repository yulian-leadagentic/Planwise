import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';

const ALL_STATUSES = ['not_started', 'in_progress', 'in_review', 'completed', 'on_hold', 'cancelled'];

/**
 * Returns the set of statuses the current user's role can transition TO
 * from a given status. If the role has no restrictions configured,
 * returns all statuses (backward compatible).
 */
export function useAllowedTransitions(fromStatus: string) {
  const { data } = useQuery({
    queryKey: ['tasks', 'allowed-transitions', fromStatus],
    queryFn: () => client.get('/tasks/allowed-transitions', { params: { fromStatus } })
      .then((r) => r.data?.data ?? r.data),
    staleTime: 5 * 60 * 1000,
  });

  // null targets = unrestricted (all allowed)
  const targets: string[] | null = data?.targets ?? null;

  const allowedStatuses = targets === null
    ? ALL_STATUSES
    : ALL_STATUSES.filter((s) => s === fromStatus || targets.includes(s));

  return { allowedStatuses, unrestricted: targets === null };
}
