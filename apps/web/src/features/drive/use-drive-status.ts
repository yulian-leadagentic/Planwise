/**
 * useDriveStatus — shared React Query hook that reports whether Google
 * Drive is configured and enabled on this Planwise instance.
 *
 * Every Drive-facing button/modal in the app calls this so it can
 * render disabled + explain WHY when Drive is off, instead of the user
 * clicking a button and getting an admin-scoped 503 toast in their face.
 *
 * The backend endpoint (`GET /drive/status`) returns ONLY two booleans;
 * no secrets are ever surfaced to the client. `enabled` is what UI
 * should gate on; `configured` is available so a future onboarding
 * banner can distinguish "not set up yet" from "set up but disabled".
 *
 * Cached for 5 minutes — an admin toggling Drive should take effect on
 * the next reload of a Drive-facing surface, not require a page refresh
 * on every navigation. The 503-toast path in the mutation catches the
 * mid-session drop between reads.
 */
import { useQuery } from '@tanstack/react-query';
import client from '@/api/client';

interface DriveStatus {
  enabled: boolean;
  configured: boolean;
  isLoading: boolean;
}

export function useDriveStatus(): DriveStatus {
  const query = useQuery({
    queryKey: ['drive', 'status'],
    queryFn: () =>
      client
        .get<{ data?: { enabled: boolean; configured: boolean } } | { enabled: boolean; configured: boolean }>(
          '/drive/status',
        )
        .then((r) => {
          const body: any = r.data;
          // The global ResponseInterceptor wraps responses in `{ data }`
          // but leaving both shapes covered keeps this hook robust to a
          // future unwrap change.
          return (body?.data ?? body) as { enabled: boolean; configured: boolean };
        }),
    // 5 minutes — an admin toggle propagates on the next fetch after the
    // window. Users don't hit this per-render, so a 5-minute cache is
    // cheap and keeps Drive-facing pages snappy.
    staleTime: 5 * 60 * 1000,
    // Don't retry hard — status is a boolean; if the network's flaky the
    // caller can treat "loading" as "assume enabled" (see below).
    retry: 1,
  });

  return {
    enabled: query.data?.enabled ?? false,
    configured: query.data?.configured ?? false,
    isLoading: query.isLoading,
  };
}
