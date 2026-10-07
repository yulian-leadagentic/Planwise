import axios from 'axios';
import * as Sentry from '@sentry/react';
import { useAuthStore } from '@/stores/auth.store';
import { notify, getErrorCode, getErrorMessage } from '@/lib/notify';
import { API_BASE } from '@/lib/runtime-config';
import { refreshOnce } from './refresh-lock';

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

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(client(originalRequest));
            },
            reject,
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // Delegate the actual POST to the shared refresh-lock so that if
        // AuthBootstrap ALSO has a refresh in flight (e.g. on F5, before
        // the spinner has released children), both callers await the same
        // network round-trip. Two parallel /auth/refresh POSTs each rotate
        // the server-side refresh token — one loses, the loser's caller
        // gets kicked to /login — that's Failure A's residual vector even
        // after the per-load queue.
        const newToken = await refreshOnce();
        useAuthStore.getState().setToken(newToken);
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return client(originalRequest);
      } catch (refreshError: any) {
        processQueue(refreshError, null);

        // FEAS-3 / fix-midwork-logout policy (incident 2026-10-07):
        // ONLY clear auth + redirect on an EXPLICIT auth failure from
        // the refresh endpoint. The previous code treated any thrown
        // refreshError — network timeout, 5xx right after a deploy,
        // Railway restart loop, AbortError — as "session invalid" and
        // forced the user to /login mid-work.
        //
        // What counts as "session invalid":
        //   • HTTP 401 from `/auth/refresh` — the refresh token is
        //     actually rejected by the server.
        //   • HTTP 403 — same (role/account disabled).
        // Everything else (network error, 5xx, timeout) is a
        // TRANSIENT failure. We reject the original request so
        // react-query / the call site can retry, but we KEEP the
        // session: the user hasn't been authenticated-out, the API
        // just briefly isn't reachable.
        const refreshStatus: number | undefined =
          refreshError?.response?.status;
        const isTerminalAuthFailure =
          refreshStatus === 401 || refreshStatus === 403;

        if (isTerminalAuthFailure) {
          console.warn(
            '[auth] refresh rejected by server (401/403) → redirecting to /login',
            refreshError?.message ?? refreshError,
          );
          useAuthStore.getState().clearAuth();
          window.location.href = '/login';
        } else {
          // Transient — keep the session. Log for diagnostics so the
          // kick-out reports still have a trail; the UI will show
          // the per-call error from the rejection below.
          console.warn(
            '[auth] refresh failed transiently (keeping session, caller may retry):',
            refreshStatus ?? refreshError?.code ?? 'network',
            refreshError?.message ?? refreshError,
          );
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
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

    return Promise.reject(error);
  },
);

export default client;
