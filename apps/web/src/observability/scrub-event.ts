/**
 * Web-side Sentry `beforeSend` — same shape as the backend scrubber:
 *   - Drop request bodies + cookies
 *   - Redact Authorization / Cookie / Set-Cookie / X-API-KEY headers
 *   - Redact credential-shaped keys anywhere (password, token, secret,
 *     apiKey, sso*key, serviceAccount, clientSecret, refreshToken, …)
 *   - Keep user context as id-only (email + IP are PII)
 *
 * Kept identical in spirit to `apps/api/src/observability/scrub-event.ts`
 * so a reviewer reading one has read both. Package intentionally not
 * shared — the SDK types differ (@sentry/react vs @sentry/node), and the
 * duplication is ~120 lines with zero domain logic.
 */

import type { ErrorEvent, Event, EventHint } from '@sentry/react';

const SECRET_KEY_RE =
  /password|token|secret|api[_-]?key|sso.*key|serviceAccount|service_account|clientSecret|client_secret|encKey|enc_key|refreshToken|refresh_token|accessToken|access_token|privateKey|private_key/i;

const REDACT_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key)$/i;

const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;
function redactKeys(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) redactKeys(item, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_RE.test(key)) {
      obj[key] = REDACTED;
      continue;
    }
    const child = obj[key];
    if (child && typeof child === 'object') redactKeys(child, depth + 1);
  }
}

function redactHeaders(headers: Record<string, unknown> | undefined): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (REDACT_HEADER_RE.test(key)) {
      headers[key] = REDACTED;
    }
  }
}

export function scrubEventWeb(
  event: ErrorEvent,
  _hint?: EventHint,
): ErrorEvent | null {
  return scrubEventLike(event as Event) as ErrorEvent;
}

function scrubEventLike(event: Event): Event | null {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    redactHeaders(event.request.headers as Record<string, unknown> | undefined);
    if (typeof event.request.query_string === 'string') {
      if (SECRET_KEY_RE.test(event.request.query_string)) {
        event.request.query_string = REDACTED;
      }
    }
  }

  redactKeys(event.contexts);
  redactKeys(event.extra);
  redactKeys(event.tags);

  if (event.breadcrumbs) {
    for (const bc of event.breadcrumbs) {
      if (bc.data) {
        redactHeaders(bc.data as Record<string, unknown>);
        redactKeys(bc.data);
      }
    }
  }

  if (event.user) {
    const { id, username } = event.user;
    event.user = id !== undefined ? { id } : username !== undefined ? { username } : {};
  }

  return event;
}

export const _internals = { SECRET_KEY_RE, REDACT_HEADER_RE, REDACTED };
