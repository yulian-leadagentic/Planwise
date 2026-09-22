/**
 * Shared single-flight refresh across bootstrap + interceptor.
 *
 * Why this exists (QA3 Wave-1 Commit 2 · Failure A hardening):
 * The axios response interceptor is already single-flight per-load: concurrent
 * 401s queue via `isRefreshing` and get replayed with the fresh token. But the
 * AuthBootstrap effect fires a raw `axios.post(/auth/refresh)` on page load
 * that is independent of the interceptor's flag. Under normal flow the
 * bootstrap spinner blocks children until it completes, so no in-app request
 * fires while bootstrap is refreshing — but that's a component-tree
 * invariant, not a network-layer one. Any module-load side effect (a stray
 * setInterval, a future WebSocket wire-up, a third-party SDK) could fire an
 * authed request BEFORE bootstrap resolves — triggering the interceptor's
 * own refresh in parallel with bootstrap's. Two /auth/refresh POSTs race, one
 * rotates the token the other used, and the loser drops the user to /login.
 *
 * This module gives both callers a shared, deduped promise. First caller
 * kicks off the POST; every caller that arrives while it's in flight awaits
 * the SAME promise. On success everyone sees the same token; on failure
 * everyone sees the same error. Zero orchestration in either caller — they
 * just call `refreshOnce()`.
 *
 * The promise is CLEARED on both success and failure so the NEXT refresh
 * event (later token expiry, user idle, whatever) starts fresh. This is
 * intentional: we don't want a single failure to permanently block future
 * refreshes for the session.
 */
import axios from 'axios';
import { API_BASE } from '@/lib/runtime-config';

let refreshInFlight: Promise<string> | null = null;

/**
 * Single-flight `POST /auth/refresh`. Returns the fresh access token.
 *
 * Callers MUST handle the rejection (bootstrap wants to fall through to the
 * unauthenticated state; the interceptor wants to clear auth + redirect).
 * Both branches let their catch clean up whatever local state they own —
 * this module only owns the shared promise slot.
 */
export function refreshOnce(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = axios
    .post(`${API_BASE}/api/v1/auth/refresh`, null, { withCredentials: true })
    .then((res) => {
      // Server may wrap the response as { success, data: { accessToken } }
      // (the ResponseInterceptor's default) or return it flat. Handle both —
      // the flat shape came up as a real production defect months back
      // where `data.data.accessToken` silently resolved to undefined.
      const token: string | undefined =
        res.data?.data?.accessToken ?? res.data?.accessToken;
      if (!token) {
        throw new Error(
          `Refresh response missing accessToken (payload: ${JSON.stringify(res.data).slice(0, 200)})`,
        );
      }
      return token;
    })
    .finally(() => {
      // Clear on either resolution so the next natural expiry can refresh
      // again. Without this a single transient failure would sticky the
      // slot with a rejected promise and every subsequent caller would
      // instantly get the old failure.
      refreshInFlight = null;
    });

  return refreshInFlight;
}
