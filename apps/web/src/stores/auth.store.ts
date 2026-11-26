import { create } from 'zustand';
import type { User } from '@/types';
import { announceAuthEvent, type LogoutReason } from '@/lib/auth-events';

/**
 * Access token is held in memory only — never localStorage — so XSS cannot
 * exfiltrate it. On page reload, the client bootstraps by calling
 * /auth/refresh (httpOnly cookie) to obtain a fresh access token.
 *
 * A lightweight "was-authenticated" flag IS stored in localStorage so the
 * app can distinguish "first visit, go to /login" from "returning user,
 * try to refresh". The flag contains no secrets.
 *
 * BM2-32 (2026-11-26): a sign-in (`setAuth`) and a sign-out (`clearAuth`)
 * also tell the other tabs of the browser (lib/auth-events.ts), because
 * they all share one refresh cookie. `dropSession` forgets the session in
 * THIS tab only, without telling anyone: it is what a tab does when it
 * reacts to another tab, or when the API refused the cookie on page load.
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
  /** Sign out: forget the session here and tell the other tabs (default reason: a deliberate sign-out). */
  clearAuth: (reason?: LogoutReason) => void;
  /** Forget the session in this tab only. `forgetFlag` also drops the "was signed in" flag. */
  dropSession: (options?: { forgetFlag?: boolean }) => void;
}

const hasAuthFlag = typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_FLAG_KEY) === '1';

const SIGNED_OUT = { accessToken: null, user: null, isAuthenticated: false, isBootstrapping: false } as const;

function displayName(user: AuthUser): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || '';
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,
  isBootstrapping: hasAuthFlag,

  setAuth: (token, user) => {
    try { localStorage.setItem(AUTH_FLAG_KEY, '1'); } catch { /* localStorage may be unavailable in private mode */ }
    set({ accessToken: token, user, isAuthenticated: true, isBootstrapping: false });
    announceAuthEvent({ type: 'login', userId: typeof user?.id === 'number' ? user.id : null, name: user ? displayName(user) : undefined });
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

  clearAuth: (reason = 'signed-out') => {
    try { localStorage.removeItem(AUTH_FLAG_KEY); } catch { /* localStorage may be unavailable in private mode */ }
    set(SIGNED_OUT);
    announceAuthEvent({ type: 'logout', reason });
  },

  dropSession: (options) => {
    if (options?.forgetFlag) {
      try { localStorage.removeItem(AUTH_FLAG_KEY); } catch { /* localStorage may be unavailable in private mode */ }
    }
    set(SIGNED_OUT);
  },
}));
