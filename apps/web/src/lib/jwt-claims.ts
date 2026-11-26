/**
 * Read the claims of an access token WITHOUT verifying it (BM2-32).
 *
 * Only used to tell which user a token belongs to (`sub`), e.g. to
 * notice that a refresh came back for a different user because someone
 * signed in as another account in another tab. Never used to make an
 * authorization decision: the API verifies every token itself.
 */
export interface AccessTokenClaims {
  sub: number;
  email?: string;
}

function decodeBase64Url(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function accessTokenClaims(token: string | null | undefined): AccessTokenClaims | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(payload));
    const sub = Number(claims?.sub);
    if (!Number.isFinite(sub)) return null;
    return { sub, email: typeof claims.email === 'string' ? claims.email : undefined };
  } catch {
    return null;
  }
}
