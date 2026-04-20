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

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  /** True until the initial refresh attempt completes, to avoid flashing /login. */
  isBootstrapping: boolean;
  setAuth: (token: string, user: User) => void;
  setUser: (user: User) => void;
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
    try { localStorage.setItem(AUTH_FLAG_KEY, '1'); } catch {}
    set({ accessToken: token, user, isAuthenticated: true, isBootstrapping: false });
  },

  setUser: (user) => {
    set({ user });
  },

  setToken: (token) => {
    try { localStorage.setItem(AUTH_FLAG_KEY, '1'); } catch {}
    set({ accessToken: token, isAuthenticated: true, isBootstrapping: false });
  },

  setBootstrapComplete: () => set({ isBootstrapping: false }),

  clearAuth: () => {
    try { localStorage.removeItem(AUTH_FLAG_KEY); } catch {}
    set({ accessToken: null, user: null, isAuthenticated: false, isBootstrapping: false });
  },
}));
