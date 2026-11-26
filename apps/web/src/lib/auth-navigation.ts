/**
 * Full-page navigations for auth changes, with a one-line note shown
 * after the page loads (BM2-32).
 *
 * A full load (not a router navigate) is deliberate: when the session
 * ends or the account changes, everything held in memory (React Query
 * cache, sockets, the previous user's data) must go. The note survives
 * the load in sessionStorage (per tab) and AuthBootstrap shows it once.
 */
const AUTH_NOTICE_KEY = 'planwise.auth_notice';

function rememberNotice(notice?: string) {
  if (!notice) return;
  try {
    sessionStorage.setItem(AUTH_NOTICE_KEY, notice);
  } catch {
    /* sessionStorage may be unavailable (private mode) */
  }
}

export function hardNavigate(url: string, notice?: string): void {
  rememberNotice(notice);
  window.location.assign(url);
}

export function hardReload(notice?: string): void {
  rememberNotice(notice);
  window.location.reload();
}

export function currentPathname(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

/** The note left by the last auth navigation in this tab, once. */
export function takeAuthNotice(): string | null {
  try {
    const notice = sessionStorage.getItem(AUTH_NOTICE_KEY);
    if (notice) sessionStorage.removeItem(AUTH_NOTICE_KEY);
    return notice;
  } catch {
    return null;
  }
}
