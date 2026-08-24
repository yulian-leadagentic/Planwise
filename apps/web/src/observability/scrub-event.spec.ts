import type { ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';

import { scrubEventWeb } from './scrub-event';

// Cast helper — every field on Sentry's Event union is optional-with-narrow-
// literal-types; the tests want to construct fixtures freely without
// re-declaring the full union. One `unknown` hop per test keeps the lint
// baseline clean.
function ev(fixture: Record<string, unknown>): ErrorEvent {
  return fixture as unknown as ErrorEvent;
}

describe('scrubEventWeb (web-side Sentry beforeSend)', () => {
  it('drops request body + cookies + redacts Authorization/Cookie headers', () => {
    const out = scrubEventWeb(
      ev({
        request: {
          method: 'POST',
          url: '/api/v1/auth/login',
          data: { email: 'x@y.z', password: 'hunter2' },
          cookies: { session: 'abc' },
          headers: {
            Authorization: 'Bearer eyJhbGciOi.secret',
            Cookie: 'session=abc',
            'X-API-KEY': 'k_live_abc',
            'user-agent': 'jest-web',
          },
        },
      }),
    )!;
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    const headers = out.request?.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers.Cookie).toBe('[REDACTED]');
    expect(headers['X-API-KEY']).toBe('[REDACTED]');
    expect(headers['user-agent']).toBe('jest-web');
  });

  it('redacts credential-shaped keys anywhere in extra / contexts', () => {
    const out = scrubEventWeb(
      ev({
        extra: {
          payload: {
            password: 'hunter2',
            SSO_ENC_KEY: 'aes256:deadbeef',
            refreshToken: 'rt_abc',
            nested: { deeper: { apiKey: 'k_live', harmless: 'kept' } },
          },
        },
      }),
    )!;
    const p = (out.extra as Record<string, Record<string, unknown>>).payload;
    expect(p.password).toBe('[REDACTED]');
    expect(p.SSO_ENC_KEY).toBe('[REDACTED]');
    expect(p.refreshToken).toBe('[REDACTED]');
    const deeper = (p.nested as Record<string, Record<string, unknown>>).deeper;
    expect(deeper.apiKey).toBe('[REDACTED]');
    expect(deeper.harmless).toBe('kept');
  });

  it('strips PII from user context — id only', () => {
    const out = scrubEventWeb(
      ev({
        user: {
          id: 42,
          email: 'user@example.com',
          ip_address: '1.2.3.4',
        },
      }),
    )!;
    expect(out.user).toEqual({ id: 42 });
  });
});
