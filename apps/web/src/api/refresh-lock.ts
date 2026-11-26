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
 * own refresh in parallel with bootstrap's.
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
 *
 * BM2-32 (2026-11-26): the API's refresh token is a stateless JWT (no
 * rotation family, no reuse detection, see
 * apps/api/src/modules/auth/bm2-32-refresh-flow.spec.ts), so two tabs
 * refreshing at once is harmless and needs no cross-tab lock. What this
 * module adds: a timeout (a hung connection used to hold every request of
 * the tab in the interceptor's queue forever), the one rule for "the API
 * really refused the session" (`isTerminalRefreshFailure`), and a short
 * retry with backoff for everything else (`refreshWithRetry`).
 */
import axios from 'axios';
import { API_BASE } from '@/lib/runtime-config';

/** A refresh slower than this is treated as a network failure (and retried). */
export const REFRESH_TIMEOUT_MS = 15_000;

/** Mid-session: wait 1s, 2s, 4s between attempts (4 attempts, about 7s), then give up for now. */
export const REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

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
    .post(`${API_BASE}/api/v1/auth/refresh`, null, { withCredentials: true, timeout: REFRESH_TIMEOUT_MS })
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

/**
 * FEAS-3 / fix-midwork-logout / BM2-32: the ONLY refresh failures that mean
 * "this browser is signed out" are an explicit 401 or 403 from the API.
 * A network error, a timeout, a 5xx (a deploy, a Railway restart) or a
 * malformed body is transient: keep the session and try again.
 */
export function isTerminalRefreshFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 401 || status === 403;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `refreshOnce`, retried with backoff while the failure is transient, so a
 * short blip (a few seconds of 502 during a deploy, a dropped Wi-Fi)
 * never reaches the user. Rejects at once on a terminal failure, and with
 * the last transient error once the delays are used up.
 */
export async function refreshWithRetry(delaysMs: number[] = REFRESH_RETRY_DELAYS_MS): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await refreshOnce();
    } catch (error) {
      if (isTerminalRefreshFailure(error) || attempt >= delaysMs.length) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}
