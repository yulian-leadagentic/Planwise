/**
 * Keeping every tab on the browser's ONE session (BM2-32, 2026-11-26).
 *
 * All tabs share one httpOnly refresh cookie; each keeps its own access
 * token in memory. Testers switch users in the same browser, so before
 * this a tab could:
 *   • stay signed in for up to an hour after the user signed out in
 *     another tab, then get thrown to /login at a random moment (its
 *     next refresh got 401): the "mid-work logout";
 *   • after another tab signed in as someone else, refresh into THAT
 *     user and replay the request it was making (a time entry saved as
 *     the wrong person) while still showing the first user's name.
 *
 * Now:
 *   • a sign-in / sign-out is announced to the other tabs
 *     (lib/auth-events.ts); each one re-checks the cookie with the API
 *     (`revalidateSession`) instead of trusting the message, so a stale
 *     or racing message can never sign out a tab whose session is fine;
 *   • a refresh that comes back for a different user switches the tab to
 *     that account with a note (`switchAccount`), never mixing the two;
 *   • page load retries a transient refresh failure instead of showing
 *     the sign-in page (`bootstrapSession`).
 */
import { useAuthStore } from '@/stores/auth.store';
import { accessTokenClaims } from '@/lib/jwt-claims';
import { AUTH_EVENT_KEY, parseAuthEvent, type AuthEvent, type LogoutReason } from '@/lib/auth-events';
import { currentPathname, hardNavigate, hardReload } from '@/lib/auth-navigation';
import { isTerminalRefreshFailure, refreshOnce } from './refresh-lock';

export const AUTH_NOTICES = {
  signedOutElsewhere: 'You signed out in another tab.',
  sessionEnded: 'Your session has ended. Please sign in again.',
  switchedAccount: (who: string) => `You signed in as ${who} in another tab. This tab now uses that account.`,
} as const;

/** Raised for requests that were made as the previous user when the account changed. */
export class AccountSwitchedError extends Error {
  readonly code = 'AUTH_ACCOUNT_SWITCHED';
  constructor() {
    super('This tab switched to the account that signed in in another tab.');
    this.name = 'AccountSwitchedError';
  }
}

/** The user id of an access token (no verification, identity only). */
export function tokenUserId(token: string | null | undefined): number | null {
  return accessTokenClaims(token)?.sub ?? null;
}

/** The session ended (here or in another tab): sign-in page, with a note. */
export function leaveSession(reason: LogoutReason): void {
  useAuthStore.getState().dropSession();
  hardNavigate('/login', reason === 'signed-out' ? AUTH_NOTICES.signedOutElsewhere : AUTH_NOTICES.sessionEnded);
}

/** The cookie now belongs to another user: reload this tab into that account, with a note. */
export function switchAccount(newToken: string): void {
  const who = accessTokenClaims(newToken)?.email ?? 'another user';
  useAuthStore.getState().dropSession();
  hardReload(AUTH_NOTICES.switchedAccount(who));
}

export type RevalidateOutcome = 'ignored' | 'unchanged' | 'signed-in' | 'signed-out' | 'switched';

/**
 * Another tab signed in or out. Ask the API what the shared cookie says
 * now, and follow it:
 *   • same user → keep working (fresh token);
 *   • another user → switch to that account;
 *   • 401 / 403 → this tab's session is over too;
 *   • network error / 5xx → keep the session; the next refresh decides.
 * A signed-out tab sitting on the sign-in page follows a sign-in.
 */
export async function revalidateSession(event: AuthEvent): Promise<RevalidateOutcome> {
  const state = useAuthStore.getState();
  if (state.isBootstrapping) return 'ignored'; // page load is reading the cookie right now

  if (!state.isAuthenticated) {
    if (event.type !== 'login' || currentPathname() !== '/login') return 'ignored';
    try {
      const token = await refreshOnce();
      if (useAuthStore.getState().isAuthenticated) return 'ignored';
      useAuthStore.getState().setToken(token);
      return 'signed-in';
    } catch {
      return 'ignored';
    }
  }

  const mine = tokenUserId(state.accessToken);
  if (event.type === 'login' && event.userId !== null && event.userId === mine) return 'unchanged';

  try {
    const token = await refreshOnce();
    const now = useAuthStore.getState();
    if (!now.isAuthenticated || tokenUserId(now.accessToken) !== mine) return 'ignored'; // this tab changed meanwhile
    const theirs = tokenUserId(token);
    if (mine === null || theirs === mine) {
      now.setToken(token);
      return 'unchanged';
    }
    switchAccount(token);
    return 'switched';
  } catch (error) {
    if (!isTerminalRefreshFailure(error)) return 'unchanged';
    if (!useAuthStore.getState().isAuthenticated) return 'ignored';
    leaveSession(event.type === 'logout' ? event.reason : 'expired');
    return 'signed-out';
  }
}

/** Listen for the other tabs' announcements. Returns the unsubscribe. AuthBootstrap calls it once. */
export function startAuthSync(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const onStorage = (e: Event) => {
    const { key, newValue } = e as StorageEvent;
    if (key !== AUTH_EVENT_KEY) return;
    const event = parseAuthEvent(newValue);
    if (event) void revalidateSession(event);
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

/** Page load: wait 1s, 2s, 4s, 8s, then every 15s while the API can't be reached. */
export const BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export interface BootstrapOptions {
  /** True once the caller no longer wants the result (component unmounted). */
  isCancelled?: () => boolean;
  /** Called before each wait with the number of failed attempts so far. */
  onRetry?: (failedAttempts: number) => void;
  delaysMs?: number[];
}

export type BootstrapOutcome = 'authenticated' | 'signed-out' | 'cancelled';

function waitBeforeRetry(ms: number, isCancelled?: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const target: EventTarget | undefined = typeof window !== 'undefined' ? window : undefined;
    const done = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      target?.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Stop waiting at once when the caller gives up...
    const poll = isCancelled
      ? setInterval(() => {
          if (isCancelled()) done();
        }, 250)
      : null;
    // ...or when the browser says the network is back.
    target?.addEventListener('online', done);
  });
}

/**
 * The page-load refresh. Before BM2-32 any failure (a 502 during a
 * deploy, a dropped connection) completed bootstrap signed out, so a
 * reload or a new tab at the wrong moment showed the sign-in page. Now
 * only a definitive 401 / 403 does; anything else is retried with
 * backoff while AuthBootstrap shows "Reconnecting".
 */
export async function bootstrapSession(options: BootstrapOptions = {}): Promise<BootstrapOutcome> {
  const delays = options.delaysMs ?? BOOTSTRAP_RETRY_DELAYS_MS;
  const cancelled = () => options.isCancelled?.() === true;
  for (let attempt = 0; ; attempt++) {
    try {
      const token = await refreshOnce();
      if (cancelled()) return 'cancelled';
      useAuthStore.getState().setToken(token);
      return 'authenticated';
    } catch (error) {
      if (cancelled()) return 'cancelled';
      if (isTerminalRefreshFailure(error)) {
        useAuthStore.getState().dropSession({ forgetFlag: true });
        return 'signed-out';
      }
      options.onRetry?.(attempt + 1);
      await waitBeforeRetry(delays[Math.min(attempt, delays.length - 1)], options.isCancelled);
      if (cancelled()) return 'cancelled';
    }
  }
}
