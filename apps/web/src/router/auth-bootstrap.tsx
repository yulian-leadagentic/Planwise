import { useEffect, useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { bootstrapSession, startAuthSync, tokenUserId } from '@/api/auth-sync';
import { announceAuthEvent } from '@/lib/auth-events';
import { takeAuthNotice } from '@/lib/auth-navigation';
import { notify } from '@/lib/notify';

/** After this many failed page-load refreshes, also offer the sign-in page. */
const OFFER_SIGN_IN_AFTER = 3;

/**
 * On page load / refresh, silently obtain a fresh access token using the
 * httpOnly refresh cookie. This lets us keep the access token in memory
 * only (safe from XSS) while still giving returning users a seamless
 * experience — no re-login on every page reload.
 *
 * Runs once at app mount. Noop if there's no "was-authenticated" flag.
 *
 * BM2-32 (2026-11-26):
 *   • a transient failure (network error, 5xx during a deploy, timeout)
 *     no longer drops the user on the sign-in page: the refresh is
 *     retried with backoff while the spinner says it is reconnecting.
 *     Only a definitive 401 / 403 means signed out (api/auth-sync.ts);
 *   • starts the cross-tab sync, so a sign-out or a sign-in as another
 *     user in another tab reaches this tab at once;
 *   • shows the one-line note an auth navigation left behind ("You
 *     signed out in another tab.").
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
  const [failedAttempts, setFailedAttempts] = useState(0);

  // Hydrate from URL fragment first — runs unconditionally so SSO
  // works even when hasAuthFlag=false (first-ever visit via SSO).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.location.hash || window.location.hash.length < 2) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('access_token');
    if (token) {
      setToken(token);
      // The other tabs share the refresh cookie the SSO callback just set.
      announceAuthEvent({ type: 'login', userId: tokenUserId(token) });
      // Clean the URL so the token isn't visible or bookmarkable.
      // `replaceState` avoids adding a history entry.
      const cleanUrl = window.location.pathname + window.location.search;
      window.history.replaceState({}, '', cleanUrl);
    }
  }, [setToken]);

  // Follow sign-ins / sign-outs made in the other tabs of this browser.
  useEffect(() => startAuthSync(), []);

  useEffect(() => {
    if (!isBootstrapping) return;
    // If the fragment hydration above already authenticated us, skip
    // the refresh — nothing to do.
    if (isAuthenticated) {
      setBootstrapComplete();
      return;
    }
    let cancelled = false;

    // Shared with the axios response interceptor via refresh-lock so that
    // any authed request that fires while this refresh is in flight (a
    // rogue module-load side effect, a background query that mounted
    // before the spinner released) awaits the SAME network round-trip
    // instead of racing a second /auth/refresh POST.
    void bootstrapSession({
      isCancelled: () => cancelled,
      onRetry: (n) => {
        if (!cancelled) setFailedAttempts(n);
      },
    });

    return () => {
      cancelled = true;
    };
  }, [isBootstrapping, isAuthenticated, setBootstrapComplete]);

  // The note an auth navigation left for this page load, shown once.
  useEffect(() => {
    if (isBootstrapping) return;
    const notice = takeAuthNotice();
    if (notice) notify.info(notice);
  }, [isBootstrapping]);

  if (isBootstrapping) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
        {failedAttempts > 0 && (
          <p role="status" className="text-[13px] text-slate-500 dark:text-slate-400">
            Can't reach the server. Reconnecting...
          </p>
        )}
        {failedAttempts >= OFFER_SIGN_IN_AFTER && (
          <button
            type="button"
            onClick={() => useAuthStore.getState().dropSession()}
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-slate-700 transition-all duration-150 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-500"
          >
            Go to sign in
          </button>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
