import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import client from '@/api/client';
import type { BoardData } from './types';

export function useExecutionBoard(projectId?: number | null, serviceId?: number | null) {
  return useQuery<BoardData>({
    queryKey: queryKeys.executionBoard.with(projectId ?? null, serviceId ?? null),
    queryFn: () =>
      client
        .get('/execution-board', {
          params: {
            ...(projectId ? { projectId } : {}),
            ...(serviceId ? { serviceId } : {}),
          },
        })
        .then((r) => r.data?.data ?? r.data),
    // Treat data as stale immediately so any invalidation (e.g., after
    // updating a task in the drawer) triggers a refetch without waiting
    // out the global 5-minute staleTime.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}
