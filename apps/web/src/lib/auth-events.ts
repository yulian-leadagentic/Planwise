/**
 * Cross-tab auth announcements (BM2-32).
 *
 * Every tab of the browser shares ONE refresh cookie, but each tab keeps
 * its own access token in memory. Before this, a tab only found out that
 * another tab had signed out (or signed in as someone else) when its own
 * access token expired, up to an hour later and in the middle of work.
 *
 * A sign-in or sign-out writes a small event to localStorage; the
 * browser fires a `storage` event in every OTHER tab of the origin
 * (auth-sync.ts listens). The event carries no secrets: a user id and a
 * display name for the note, or a reason. The receiving tab does not
 * trust it blindly: it asks the API (refresh) what the cookie says now.
 */
export const AUTH_EVENT_KEY = 'planwise.auth_event';

/** Why a tab ended its session: a deliberate sign-out, or the API refused the refresh. */
export type LogoutReason = 'signed-out' | 'expired';

export type AuthEvent =
  | { type: 'login'; userId: number | null; name?: string; at: number }
  | { type: 'logout'; reason: LogoutReason; at: number };

type NewAuthEvent =
  | { type: 'login'; userId: number | null; name?: string }
  | { type: 'logout'; reason: LogoutReason };

export function announceAuthEvent(event: NewAuthEvent): void {
  try {
    // `at` + a random part: the same value written twice fires no `storage` event.
    const value = JSON.stringify({ ...event, at: Date.now(), nonce: Math.random().toString(36).slice(2) });
    localStorage.setItem(AUTH_EVENT_KEY, value);
  } catch {
    /* localStorage may be unavailable (private mode): tabs then sync on their next refresh */
  }
}

export function parseAuthEvent(raw: string | null | undefined): AuthEvent | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw);
    if (e?.type === 'login') {
      return { type: 'login', userId: typeof e.userId === 'number' ? e.userId : null, name: typeof e.name === 'string' ? e.name : undefined, at: Number(e.at) || 0 };
    }
    if (e?.type === 'logout') {
      return { type: 'logout', reason: e.reason === 'expired' ? 'expired' : 'signed-out', at: Number(e.at) || 0 };
    }
  } catch {
    /* not ours */
  }
  return null;
}
