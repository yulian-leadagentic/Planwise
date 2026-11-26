/**
 * The refresh-token cookie, in one place (BM2-32, 2026-11-26).
 *
 * Login, refresh, logout and the SSO callback all write the same cookie,
 * so they must agree on its name and attributes: the browser treats a
 * cookie with a different path as a second cookie, and ignores a delete
 * (logout) whose attributes don't match.
 *
 * In staging/prod the web app and the API are served from different
 * subdomains of up.railway.app (a public suffix), so the refresh cookie
 * travels cross-site on the /auth/refresh XHR. `SameSite=None; Secure`
 * is required for the browser to send it; anything stricter silently
 * drops the cookie and the user gets logged out on token expiry (the
 * SSO callback used to write `SameSite=Strict`, which did exactly that).
 * Local dev is same-origin http, so `SameSite=Lax` + `Secure=false`.
 *
 * Detection: explicit AUTH_CROSS_SITE=true wins; otherwise anything
 * that isn't `development` (staging, production, test on a real host)
 * is treated as cross-site. Railway sets NODE_ENV=staging on staging,
 * so an equality check against `production` alone would silently drop
 * the cookie there.
 */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Same lifetime as the refresh JWT (`expiresIn: '7d'` in AuthService). */
export const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function refreshCookieOptions() {
  const explicit = process.env.AUTH_CROSS_SITE;
  const crossSite =
    explicit === 'true' ||
    (explicit !== 'false' && (process.env.NODE_ENV ?? 'development') !== 'development');
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    path: '/',
  };
}
