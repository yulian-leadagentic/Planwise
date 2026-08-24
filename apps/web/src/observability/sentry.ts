/**
 * Sentry init for the web app.
 *
 * FAIL OPEN — same hard rule as the API: if `VITE_SENTRY_DSN` is unset,
 * `initSentryWeb` is a silent no-op. A missing observability var must never
 * take a Vite build or a page load down (see the SSO_ENC_KEY crash
 * post-mortem in docs/bm2/observability-sentry-spec.md).
 *
 * Session Replay is deliberately OFF — it's PII-heavy (renders form values,
 * text, network calls into a replayable session) and the spec calls that a
 * decision for Yulian, not a default.
 */

import * as Sentry from '@sentry/react';

import { scrubEventWeb } from './scrub-event';

let initialized = false;

export function initSentryWeb(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return; // fail-open

  Sentry.init({
    dsn,
    environment:
      (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ??
      import.meta.env.MODE,
    // Vite build injects VITE_SENTRY_RELEASE via the Sentry Vite plugin;
    // VITE_GIT_COMMIT_SHA is the manual fallback (some ops setups plumb it
    // themselves during CI).
    release:
      (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ??
      (import.meta.env.VITE_GIT_COMMIT_SHA as string | undefined),
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend: scrubEventWeb,
    // NOTE: no Replay / Session integrations by design — see file header.
  });

  initialized = true;
}

export function isSentryWebEnabled(): boolean {
  return initialized && Sentry.getClient() !== undefined;
}
