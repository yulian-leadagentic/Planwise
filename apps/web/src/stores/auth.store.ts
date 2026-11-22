import { create } from 'zustand';
import type { User } from '@/types';

/**
 * Access token is held in memory only — never localStorage — so XSS cannot
 * exfiltrate it. On page reload, the client bootstraps by calling
 * /auth/refresh (httpOnly cookie) to obtain a fresh access token.
 *
 * A lightweight "was-authenticated" flag IS stored in localStorage so the
 * app can distinguish "first visit, go to /login" from "returning user,
 * try to refresh". The flag contains no secrets.
 */
const AUTH_FLAG_KEY = 'planwise.was_authenticated';

/**
 * The signed-in user as the auth endpoints return it. Permissions
 * round 3 (2026-11-22): `mustChangePassword` (login response, /auth/me)
 * — while true, PrivateRoute shows only the "Set a new password" screen
 * and the API answers every other route with 403 PASSWORD_CHANGE_REQUIRED.
 */
export type AuthUser = User & { mustChangePassword?: boolean };

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True until the initial refresh attempt completes, to avoid flashing /login. */
  isBootstrapping: boolean;
  setAuth: (token: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  /** Flip the forced-password-change flag on the cached user (no-op when signed out). */
  setMustChangePassword: (value: boolean) => void;
  setToken: (token: string) => void;
  setBootstrapComplete: () => void;
  clearAuth: () => void;
}

const hasAuthFlag = typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_FLAG_KEY) === '1';

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,
  isBootstrapping: hasAuthFlag,

  setAuth: (token, user) => {
    try { localStorage.setItem(AUTH_FLAG_KEY, '1'); } catch { /* localStorage may be unavailable in private mode */ }
    set({ accessToken: token, user, isAuthenticated: true, isBootstrapping: false });
  },

  setUser: (user) => {
    set({ user });
  },

  setMustChangePassword: (value) => {
    set((state) =>
      state.user && state.user.mustChangePassword !== value
        ? { user: { ...state.user, mustChangePassword: value } }
        : state,
    );
  },

  setToken: (token) => {
    try { localStorage.setItem(AUTH_FLAG_KEY, '1'); } catch { /* localStorage may be unavailable in private mode */ }
    set({ accessToken: token, isAuthenticated: true, isBootstrapping: false });
  },

  setBootstrapComplete: () => set({ isBootstrapping: false }),

  clearAuth: () => {
    try { localStorage.removeItem(AUTH_FLAG_KEY); } catch { /* localStorage may be unavailable in private mode */ }
    set({ accessToken: null, user: null, isAuthenticated: false, isBootstrapping: false });
  },
}));
