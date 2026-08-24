import type { Event } from '@sentry/node';

import { scrubEvent, _internals } from './scrub-event';

describe('scrubEvent (Sentry beforeSend)', () => {
  it('drops the request body outright — bodies carry PII / secrets', () => {
    const event: Event = {
      request: {
        method: 'POST',
        url: '/api/v1/auth/login',
        data: { email: 'x@y.z', password: 'hunter2' },
      },
    };
    const out = scrubEvent(event)!;
    expect(out.request?.data).toBeUndefined();
  });

  it('drops cookies + redacts Authorization/Cookie/Set-Cookie/x-api-key headers', () => {
    const event: Event = {
      request: {
        headers: {
          Authorization: 'Bearer eyJhbGciOi.secret',
          authorization: 'Bearer other-token', // case-insensitive
          Cookie: 'session=abc',
          'set-cookie': 'session=abc; Path=/',
          'X-API-KEY': 'k_live_abc',
          'user-agent': 'jest',
          'x-forwarded-for': '1.2.3.4',
        },
        cookies: { session: 'abc' },
      },
    };
    const out = scrubEvent(event)!;
    expect(out.request?.cookies).toBeUndefined();
    const headers = out.request?.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers.authorization).toBe('[REDACTED]');
    expect(headers.Cookie).toBe('[REDACTED]');
    expect(headers['set-cookie']).toBe('[REDACTED]');
    expect(headers['X-API-KEY']).toBe('[REDACTED]');
    // Non-sensitive headers untouched
    expect(headers['user-agent']).toBe('jest');
    expect(headers['x-forwarded-for']).toBe('1.2.3.4');
  });

  it('redacts credential-shaped keys anywhere in contexts / extra', () => {
    const event: Event = {
      extra: {
        payload: {
          password: 'hunter2',
          SSO_ENC_KEY: 'aes256:deadbeef',
          sso_enc_key: 'lowercase-variant',
          refreshToken: 'rt_abc',
          service_account_json: '{ ... }',
          clientSecret: 'cs_live_abc',
          nested: {
            deeper: {
              apiKey: 'k_live',
              privateKey: '-----BEGIN PRIVATE KEY-----',
              harmless: 'kept',
            },
          },
        },
      },
      contexts: {
        auth: { accessToken: 'at_xyz', role: 'admin' },
      },
    };
    const out = scrubEvent(event)!;
    const payload = (out.extra as any).payload;
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.SSO_ENC_KEY).toBe('[REDACTED]');
    expect(payload.sso_enc_key).toBe('[REDACTED]');
    expect(payload.refreshToken).toBe('[REDACTED]');
    expect(payload.service_account_json).toBe('[REDACTED]');
    expect(payload.clientSecret).toBe('[REDACTED]');
    expect(payload.nested.deeper.apiKey).toBe('[REDACTED]');
    expect(payload.nested.deeper.privateKey).toBe('[REDACTED]');
    expect(payload.nested.deeper.harmless).toBe('kept');
    expect((out.contexts as any).auth.accessToken).toBe('[REDACTED]');
    expect((out.contexts as any).auth.role).toBe('admin');
  });

  it('redacts credential-shaped values inside breadcrumb data + headers', () => {
    const event: Event = {
      breadcrumbs: [
        {
          category: 'http',
          data: {
            method: 'POST',
            url: '/api/v1/auth/login',
            Authorization: 'Bearer secret',
            requestBody: { password: 'hunter2' },
          },
        },
      ],
    };
    const out = scrubEvent(event)!;
    const bc = out.breadcrumbs![0].data as any;
    expect(bc.Authorization).toBe('[REDACTED]');
    expect(bc.requestBody.password).toBe('[REDACTED]');
    expect(bc.method).toBe('POST');
    expect(bc.url).toBe('/api/v1/auth/login');
  });

  it('strips PII from user context — id only, drops email/ip_address/username-extras', () => {
    const event: Event = {
      user: {
        id: 42,
        email: 'user@example.com',
        ip_address: '1.2.3.4',
        segment: 'admin',
      } as any,
    };
    const out = scrubEvent(event)!;
    expect(out.user).toEqual({ id: 42 });
  });

  it('preserves user context when only username is present', () => {
    const event: Event = { user: { username: 'ada', email: 'ada@x.com' } as any };
    const out = scrubEvent(event)!;
    expect(out.user).toEqual({ username: 'ada' });
  });

  it('redacts the query string when it contains a credential-shaped param', () => {
    const event: Event = {
      request: { query_string: 'foo=1&access_token=abc123' },
    };
    const out = scrubEvent(event)!;
    expect(out.request?.query_string).toBe('[REDACTED]');
  });

  it('leaves an empty event untouched', () => {
    const out = scrubEvent({})!;
    expect(out).toEqual({});
  });

  it('does not hang on deep / recursive nesting (bounded depth walk)', () => {
    // Build a 40-deep chain with a secret at the leaf. Walker caps at 8 —
    // we don't assert the leaf is redacted; we assert it doesn't blow up.
    const root: any = { level: 0 };
    let cur = root;
    for (let i = 1; i < 40; i++) {
      cur.next = { level: i };
      cur = cur.next;
    }
    cur.password = 'deep-secret';
    const event: Event = { extra: { root } };
    expect(() => scrubEvent(event)).not.toThrow();
  });

  it('exports the secret regex — sanity that the pattern catches known cases', () => {
    const { SECRET_KEY_RE } = _internals;
    expect(SECRET_KEY_RE.test('password')).toBe(true);
    expect(SECRET_KEY_RE.test('SSO_ENC_KEY')).toBe(true);
    expect(SECRET_KEY_RE.test('clientSecret')).toBe(true);
    expect(SECRET_KEY_RE.test('service_account')).toBe(true);
    expect(SECRET_KEY_RE.test('refreshToken')).toBe(true);
    expect(SECRET_KEY_RE.test('username')).toBe(false);
    expect(SECRET_KEY_RE.test('email')).toBe(false);
  });
});
