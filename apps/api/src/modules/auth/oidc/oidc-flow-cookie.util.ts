/**
 * Signed, short-lived cookie that carries the transient OIDC state
 * (state, nonce, PKCE verifier) from /login to /callback. Kept in a
 * cookie rather than server-side storage so the API stays stateless
 * — the flow lives entirely in the round trip.
 *
 * Encoding: base64url(JSON) + "." + base64url(HMAC-SHA256). Signed
 * with SSO_ENC_KEY so tampering fails constant-time verification;
 * we don't reuse the encryption key for AES here because the cookie
 * is authenticated, not confidential — the state/nonce/verifier are
 * meaningless to an attacker without also holding the AS's
 * authorization response.
 *
 * If SSO_ENC_KEY happens to change between login and callback (key
 * rotation mid-flight) the verify step throws and the callback
 * returns 400. Users just re-click Sign-in.
 */

import * as crypto from 'crypto';
import type { Request, Response } from 'express';

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  provider: string;
  redirectUri: string;
  /** Unix ms — enforces the 5-min TTL server-side even if a browser
   *  ignores Max-Age. */
  createdAt: number;
}

const COOKIE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function keyBytes(): Buffer {
  const raw = process.env.SSO_ENC_KEY;
  if (!raw) {
    throw new Error('SSO_ENC_KEY missing — cannot sign OIDC flow cookie');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('SSO_ENC_KEY has wrong length — cannot sign OIDC flow cookie');
  }
  return buf;
}

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(input: string): Buffer {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return Buffer.from(s, 'base64');
}

function cookieName(provider: string) {
  return `oidc_flow_${provider}`;
}

function cookiePath(provider: string) {
  // Scoped tightly to the callback so this cookie doesn't ride
  // along on unrelated requests.
  return `/api/v1/auth/oidc/${provider}/callback`;
}

export function setSignedFlowCookie(res: Response, state: OidcFlowState, provider: string): void {
  const payload = b64urlEncode(JSON.stringify(state));
  const sig = b64urlEncode(crypto.createHmac('sha256', keyBytes()).update(payload).digest());
  const value = `${payload}.${sig}`;
  res.cookie(cookieName(provider), value, {
    httpOnly: true,
    // sameSite='lax' allows the top-level redirect BACK from Entra
    // to arrive with the cookie attached. 'strict' would drop it.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: cookiePath(provider),
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function readSignedFlowCookie(req: Request, provider: string): OidcFlowState | null {
  const raw = req.cookies?.[cookieName(provider)];
  if (!raw || typeof raw !== 'string') return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) throw new Error('malformed flow cookie');
  const expected = b64urlEncode(crypto.createHmac('sha256', keyBytes()).update(payload).digest());
  // Constant-time compare. Buffer.equals on same-length inputs is
  // constant-time in Node's crypto.timingSafeEqual sense; use it via
  // timingSafeEqual after the length check.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('flow cookie signature mismatch');
  }
  let parsed: OidcFlowState;
  try {
    parsed = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    throw new Error('flow cookie payload not JSON');
  }
  if (typeof parsed !== 'object' || !parsed?.state || !parsed?.nonce || !parsed?.codeVerifier) {
    throw new Error('flow cookie payload malformed');
  }
  if (Date.now() - parsed.createdAt > COOKIE_MAX_AGE_MS) {
    throw new Error('flow cookie expired');
  }
  return parsed;
}

export function clearFlowCookie(res: Response, provider: string): void {
  res.clearCookie(cookieName(provider), { path: cookiePath(provider) });
}
