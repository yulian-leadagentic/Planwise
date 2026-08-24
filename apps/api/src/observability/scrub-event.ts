/**
 * scrubEvent — Sentry `beforeSend` hook.
 *
 * Never send:
 *   - `Authorization` / `Cookie` headers (case-insensitive)
 *   - `event.request.data` (raw request body — see the SSO / contact PII risk
 *     called out in docs/bm2/observability-sentry-spec.md)
 *   - Any object key that reads as a secret/credential:
 *     `password`, `token`, `secret`, `apiKey`, `ssoEncKey`, `serviceAccount`,
 *     `clientSecret`, … (matched case-insensitively via `SECRET_KEY_RE`).
 *
 * Redacted values are replaced with the literal string `"[REDACTED]"` so a
 * reviewer can see *that* a field was captured but stripped; dropping keys
 * outright would hide the fact that user input reached the SDK.
 *
 * Returning the same event (mutated) is the Sentry convention; returning
 * `null` drops the event entirely — we prefer scrub + keep so we still get
 * the stack + release for triage.
 */

import type { ErrorEvent, Event, EventHint } from '@sentry/node';

/**
 * Matches any key that looks credential-ish. Kept broad on purpose — false
 * positives (a legitimate field called `token_type`) are cheap; false
 * negatives (leaking `sso_enc_key`) are not.
 */
const SECRET_KEY_RE =
  /password|token|secret|api[_-]?key|sso.*key|serviceAccount|service_account|clientSecret|client_secret|encKey|enc_key|refreshToken|refresh_token|accessToken|access_token|privateKey|private_key/i;

const REDACT_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key)$/i;

const REDACTED = '[REDACTED]';

/**
 * Recursively walk `value` and redact any key matching `SECRET_KEY_RE`.
 * Mutates in place. Bounded to `MAX_DEPTH` so a pathological cyclic object
 * (Sentry usually normalizes cycles first, but be defensive) can't hang the
 * `beforeSend` pipeline.
 */
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

function redactHeaders(
  headers: Record<string, unknown> | undefined,
): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (REDACT_HEADER_RE.test(key)) {
      headers[key] = REDACTED;
    }
  }
}

/**
 * Sentry's `beforeSend` hook is typed as `(ErrorEvent, EventHint) => ErrorEvent | null | Promise<...>`.
 * We take `Event` internally so the helpers can also be reused for
 * transactions/breadcrumbs if we ever wire up a `beforeSendTransaction`.
 */
export function scrubEvent(
  event: ErrorEvent,
  _hint?: EventHint,
): ErrorEvent | null {
  return scrubEventLike(event as Event) as ErrorEvent;
}

function scrubEventLike(event: Event): Event | null {
  // 1. Request body is never useful triage payload and always risky.
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    redactHeaders(event.request.headers as Record<string, unknown> | undefined);
    // query_string may include tokens (?access_token=…) — redact if it does.
    if (typeof event.request.query_string === 'string') {
      if (SECRET_KEY_RE.test(event.request.query_string)) {
        event.request.query_string = REDACTED;
      }
    }
  }

  // 2. Contexts + extra + tags — walk them for credential-shaped keys.
  redactKeys(event.contexts);
  redactKeys(event.extra);
  redactKeys(event.tags);

  // 3. Breadcrumbs frequently carry request headers / bodies.
  if (event.breadcrumbs) {
    for (const bc of event.breadcrumbs) {
      if (bc.data) {
        redactHeaders(bc.data as Record<string, unknown>);
        redactKeys(bc.data);
      }
    }
  }

  // 4. User: keep id only unless PII was explicitly opted in.
  //    (sendDefaultPii=false already blocks auto-attached IPs; this is
  //    belt-and-suspenders in case a setUser() call carried extras.)
  if (event.user) {
    const { id, username } = event.user;
    event.user = id !== undefined ? { id } : username !== undefined ? { username } : {};
  }

  return event;
}

// Exported for tests.
export const _internals = { SECRET_KEY_RE, REDACT_HEADER_RE, REDACTED, redactKeys };
