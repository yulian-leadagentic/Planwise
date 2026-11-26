import axios from 'axios';
import * as Sentry from '@sentry/react';
import { useAuthStore } from '@/stores/auth.store';
import { notify, getErrorCode, getErrorMessage } from '@/lib/notify';
import { API_BASE } from '@/lib/runtime-config';
import { hardNavigate } from '@/lib/auth-navigation';
import { isTerminalRefreshFailure, refreshWithRetry } from './refresh-lock';
import { AUTH_NOTICES, AccountSwitchedError, switchAccount, tokenUserId } from './auth-sync';

const client = axios.create({
  baseURL: `${API_BASE}/api/v1`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

client.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // When the request body is FormData (multipart file upload), delete the
  // instance-default `Content-Type: application/json` so the browser can set
  // `multipart/form-data; boundary=<token>` itself — without the boundary
  // multer on the server can't split the parts and returns
  // "no file was uploaded (use the 'file' form field)".
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    if (config.headers && typeof (config.headers as any).delete === 'function') {
      (config.headers as any).delete('Content-Type');
    } else if (config.headers) {
      delete (config.headers as any)['Content-Type'];
    }
  }
  return config;
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null) {
  failedQueue.forEach((p) => {
    if (error) {
      p.reject(error);
    } else {
      p.resolve(token!);
    }
  });
  failedQueue = [];
}

interface SentRequest {
  url?: string;
  headers?: { get?: (name: string) => unknown; Authorization?: unknown };
}

/** The bearer token a request was sent with (AxiosHeaders or a plain object). */
function sentToken(config: SentRequest | undefined): string | null {
  const header: unknown = config?.headers?.get?.('Authorization') ?? config?.headers?.Authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** 401s from these mean "wrong credentials" / "no session", never "access token expired". */
function isAuthEndpoint(config: SentRequest | undefined): boolean {
  const path = String(config?.url ?? '').split('?')[0];
  return /\/auth\/(login|refresh)$/.test(path);
}

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const auth = useAuthStore.getState();
    // BM2-32: a tab that is signed out (and not loading) has no session to
    // refresh. A late 401 after signing out, or a wrong password on the
    // sign-in page, used to call /auth/refresh, get 401 and reload the
    // page (the sign-in error vanished with it).
    const signedOut = !auth.accessToken && !auth.isBootstrapping;

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isAuthEndpoint(originalRequest) &&
      !signedOut
    ) {
      // BM2-32: the 401 is for an older token than the one this tab holds
      // now (it was in flight while another request refreshed): replay it
      // with the current token instead of refreshing a second time.
      const sent = sentToken(originalRequest);
      if (auth.accessToken && sent && sent !== auth.accessToken && !isRefreshing && !originalRequest._staleReplay) {
        originalRequest._staleReplay = true;
        originalRequest.headers.Authorization = `Bearer ${auth.accessToken}`;
        return client(originalRequest);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: (token: string) => {
              originalRequest._retry = true;
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(client(originalRequest));
            },
            reject,
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;
      // Who this tab is signed in as, before the refresh (null while loading).
      const userBefore = tokenUserId(auth.accessToken);

      try {
        // Delegate the actual POST to the shared refresh-lock so that if
        // AuthBootstrap ALSO has a refresh in flight (e.g. on F5, before
        // the spinner has released children), both callers await the same
        // network round-trip. A short blip (network error, 5xx, timeout)
        // is retried with backoff before giving up (BM2-32).
        const newToken = await refreshWithRetry();

        // BM2-32: one refresh cookie per browser. If someone signed in as
        // another user in another tab, the refresh answers for THAT user.
        // Never replay this tab's requests under the other identity, and
        // never keep showing the first user's name on the second user's
        // session: switch the tab to that account, with a note.
        const userAfter = tokenUserId(newToken);
        if (userBefore !== null && userAfter !== null && userAfter !== userBefore) {
          const switched = new AccountSwitchedError();
          processQueue(switched, null);
          console.warn('[auth] the refresh cookie now belongs to another user, reloading this tab into that account');
          switchAccount(newToken);
          return Promise.reject(switched);
        }

        useAuthStore.getState().setToken(newToken);
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return client(originalRequest);
      } catch (refreshError: any) {
        processQueue(refreshError, null);

        // FEAS-3 / fix-midwork-logout policy (incident 2026-10-07):
        // ONLY sign out on an EXPLICIT auth failure from the refresh
        // endpoint (401 / 403: the refresh cookie is gone, expired or
        // the account is disabled). Everything else (network error,
        // 5xx, timeout), still failing after the retries above, is
        // TRANSIENT: reject the original request so react-query / the
        // call site can retry, but KEEP the session.
        if (isTerminalRefreshFailure(refreshError)) {
          console.warn(
            '[auth] refresh rejected by server (401/403) → redirecting to /login',
            refreshError?.message ?? refreshError,
          );
          // While the page is still loading, AuthBootstrap owns this outcome.
          if (useAuthStore.getState().isAuthenticated) {
            useAuthStore.getState().clearAuth('expired');
            hardNavigate('/login', AUTH_NOTICES.sessionEnded);
          }
        } else {
          // Transient — keep the session. Log for diagnostics so the
          // kick-out reports still have a trail; the UI will show
          // the per-call error from the rejection below.
          console.warn(
            '[auth] refresh failed transiently (keeping session, caller may retry):',
            refreshError?.response?.status ?? refreshError?.code ?? 'network',
            refreshError?.message ?? refreshError,
          );
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // Permissions round 3 (2026-11-22) — the API refuses every route but
    // the self-service ones while the user still has to replace a
    // password someone else chose. Flip the cached flag so PrivateRoute
    // swaps the app for the "Set a new password" screen (covers a reset
    // that happened while this tab was already signed in).
    if (error.response?.status === 403 && error.response?.data?.error?.code === 'PASSWORD_CHANGE_REQUIRED') {
      useAuthStore.getState().setMustChangePassword(true);
    }

    // Observability: leave a breadcrumb on every response error, and
    // capture 5xx / network failures to Sentry. 4xx stays out — those are
    // validation / permission / not-found signals we already surface to the
    // user through notify.tsx and would be pure Sentry noise.
    try {
      const status: number | undefined = error?.response?.status;
      const method: string | undefined = (error?.config?.method ?? '').toUpperCase();
      const url: string | undefined = error?.config?.url;

      Sentry.addBreadcrumb({
        category: 'http',
        level: status && status >= 500 ? 'error' : 'warning',
        message: `${method || '?'} ${url ?? '?'} → ${status ?? error?.code ?? 'ERR'}`,
        data: { method, url, status, code: error?.code },
      });

      const isNetworkError = error?.code === 'ERR_NETWORK' || !error?.response;
      const isServerError = typeof status === 'number' && status >= 500;
      if (isServerError || isNetworkError) {
        Sentry.captureException(error, {
          tags: { source: 'axios', method, status: status ? String(status) : 'network' },
          extra: { method, url, status },
        });
      }
    } catch {
      // Never let observability itself throw inside the interceptor —
      // that would swallow the underlying request error.
    }

    await decodeBlobErrorBody(error);
    return Promise.reject(error);
  },
);

/**
 * File downloads use `responseType: 'blob'`, so an error response (e.g.
 * a 403 "You can't export cost reports …") arrives as a Blob and
 * notify.apiError could only show axios' "Request failed with status
 * code 403". Turn a JSON error body back into the normal envelope so the
 * server's message reaches the user. Anything else is left untouched.
 */
async function decodeBlobErrorBody(error: any): Promise<void> {
  const data = error?.response?.data;
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return;
  if (!/json/i.test(data.type || '')) return;
  try {
    error.response.data = JSON.parse(await data.text());
  } catch {
    // Not JSON after all — keep the blob.
  }
}

export default client;
