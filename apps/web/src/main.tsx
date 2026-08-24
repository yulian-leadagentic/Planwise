import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';

import { App } from './App';
import { initSentryWeb } from './observability/sentry';
import { ErrorFallback } from './observability/error-fallback';
import './styles/globals.css';

// Sentry init BEFORE anything else — fail-open, silently no-ops when
// VITE_SENTRY_DSN is unset so a missing observability var can never break a
// Vite build or the page load (SSO_ENC_KEY-crash lesson, see
// docs/bm2/observability-sentry-spec.md).
initSentryWeb();

// Unhandled promise rejections (uncaught `throw` inside an async that has no
// `.catch`) don't hit React's error boundary. Ship them to Sentry with a
// clear tag so they don't get lost among render errors. Safe when Sentry
// wasn't inited — `captureException` on the no-op client is a no-op.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    Sentry.captureException(reason, { tags: { source: 'unhandledrejection' } });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
     * Sentry.ErrorBoundary catches render-time crashes anywhere below and
     * reports them (with component-stack) to Sentry when it's inited. When
     * Sentry is disabled the boundary still catches and shows the fallback —
     * so we always kill the white-screen / infinite-"Loading…" class of bug,
     * even without observability wired.
     *
     * `showDialog={false}` because Sentry's built-in report dialog is a modal
     * with an email/name capture we don't want (PII). Users get our own
     * fallback with a Reload button.
     */}
    <Sentry.ErrorBoundary fallback={({ error }) => <ErrorFallback error={error} />}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
