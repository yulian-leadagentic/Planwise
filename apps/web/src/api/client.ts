import axios from 'axios';
import { useAuthStore } from '@/stores/auth.store';
import { notify, getErrorCode, getErrorMessage } from '@/lib/notify';
import { API_BASE } from '@/lib/runtime-config';

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
        const { data } = await axios.post(`${API_BASE}/api/v1/auth/refresh`, null, {
          withCredentials: true,
        });
        // Defensive: handle BOTH wrapped { success, data: { accessToken } }
        // and unwrapped { accessToken } response shapes. The wrapping
        // interceptor handles this server-side, but if it ever yields a
        // different shape (e.g. on a misconfigured route or future
        // refactor), the old `data.data.accessToken` line silently set
        // the token to undefined and the user got "logged out" without
        // ever seeing /login — the most likely cause of the
        // long-session kick-out reports.
        const newToken: string | undefined =
          data?.data?.accessToken ?? data?.accessToken;
        if (!newToken) {
          throw new Error(
            `Refresh response missing accessToken (payload: ${JSON.stringify(data).slice(0, 200)})`,
          );
        }
        useAuthStore.getState().setToken(newToken);
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return client(originalRequest);
      } catch (refreshError: any) {
        processQueue(refreshError, null);
        // Log to the console so the failure is visible (helps diagnose
        // the kick-out reports). The redirect still happens — but at
        // least we leave a trace.
        console.warn('[auth] refresh failed → redirecting to /login', refreshError?.message ?? refreshError);
        useAuthStore.getState().clearAuth();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

export default client;
