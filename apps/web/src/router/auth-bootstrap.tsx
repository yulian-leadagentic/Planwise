import { useEffect } from 'react';
import axios from 'axios';
import { useAuthStore } from '@/stores/auth.store';
import { API_BASE } from '@/lib/runtime-config';

/**
 * On page load / refresh, silently obtain a fresh access token using the
 * httpOnly refresh cookie. This lets us keep the access token in memory
 * only (safe from XSS) while still giving returning users a seamless
 * experience — no re-login on every page reload.
 *
 * Runs once at app mount. Noop if there's no "was-authenticated" flag.
 *
 * SSO landing: the OIDC callback redirects back with the newly-minted
 * access token in the URL fragment (`#access_token=...`). Fragments
 * never hit the server, Referer, or logs — safer than a query param.
 * We hydrate from the fragment BEFORE the refresh-cookie attempt so
 * the first paint after an SSO login goes straight to the app.
 */
export function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const isBootstrapping = useAuthStore((s) => s.isBootstrapping);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setToken = useAuthStore((s) => s.setToken);
  const setBootstrapComplete = useAuthStore((s) => s.setBootstrapComplete);

  // Hydrate from URL fragment first — runs unconditionally so SSO
  // works even when hasAuthFlag=false (first-ever visit via SSO).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash || window.location.hash.length < 2) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('access_token');
    if (token) {
      setToken(token);
      // Clean the URL so the token isn't visible or bookmarkable.
      // `replaceState` avoids adding a history entry.
      const cleanUrl = window.location.pathname + window.location.search;
      window.history.replaceState({}, '', cleanUrl);
    }
  }, [setToken]);

  useEffect(() => {
    if (!isBootstrapping) return;
    // If the fragment hydration above already authenticated us, skip
    // the refresh — nothing to do.
    if (isAuthenticated) {
      setBootstrapComplete();
      return;
    }
    let cancelled = false;

    axios
      .post(`${API_BASE}/api/v1/auth/refresh`, null, { withCredentials: true })
      .then((res) => {
        if (cancelled) return;
        const token = res.data?.data?.accessToken ?? res.data?.accessToken;
        if (token) setToken(token);
        else setBootstrapComplete();
      })
      .catch(() => {
        if (!cancelled) setBootstrapComplete();
      });

    return () => {
      cancelled = true;
    };
  }, [isBootstrapping, isAuthenticated, setToken, setBootstrapComplete]);

  if (isBootstrapping) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
