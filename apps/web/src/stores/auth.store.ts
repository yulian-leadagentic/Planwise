import { create } from 'zustand';
import type { User } from '@/types';

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;
  setAuth: (token: string, user: User) => void;
  setUser: (user: User) => void;
  setToken: (token: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: localStorage.getItem('access_token'),
  user: null,
  isAuthenticated: !!localStorage.getItem('access_token'),

  setAuth: (token, user) => {
    localStorage.setItem('access_token', token);
    set({ accessToken: token, user, isAuthenticated: true });
  },

  setUser: (user) => {
    set({ user });
  },

  setToken: (token) => {
    localStorage.setItem('access_token', token);
    set({ accessToken: token, isAuthenticated: true });
  },

  clearAuth: () => {
    localStorage.removeItem('access_token');
    set({ accessToken: null, user: null, isAuthenticated: false });
  },
}));
