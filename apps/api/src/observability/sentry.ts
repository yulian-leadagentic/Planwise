/**
 * Sentry init for the API.
 *
 * FAIL OPEN — this is the whole point (see the SSO_ENC_KEY crash post-mortem
 * in docs/bm2/observability-sentry-spec.md). If `SENTRY_DSN` is unset, this
 * module MUST be a no-op: no throw, no side effects, no crash. A missing
 * observability var must never take the API down.
 *
 * Called from `main.ts` BEFORE `NestFactory.create()` — same placement as the
 * BigInt JSON patch, so any errors raised while the app module is still being
 * evaluated are captured.
 */

import * as Sentry from '@sentry/node';

import { scrubEvent } from './scrub-event';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // fail-open — Sentry disabled, app runs normally.

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // Tie every event to a commit. Railway injects RAILWAY_GIT_COMMIT_SHA
    // automatically; SENTRY_RELEASE is the manual override if we ever want to
    // pin a release tag independent of the deploy SHA.
    release: process.env.SENTRY_RELEASE ?? process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1, // perf sampling; tune later
    // Do NOT auto-attach request IPs / headers / bodies. `scrubEvent` handles
    // anything that slips through despite this.
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });

  initialized = true;
}

/** For tests / diagnostics — safe to call whether Sentry inited or not. */
export function isSentryEnabled(): boolean {
  return initialized && Sentry.getClient() !== undefined;
}
