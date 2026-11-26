/**
 * QA6 package 11, BM2-32 (2026-11-26): "No mid-work logout on a
 * transient refresh blip".
 *
 * The real AuthController + AuthService + passport strategies
 * (local / jwt / refresh) behind a real HTTP stack (supertest +
 * cookie-parser) over the in-memory Prisma. The browser cookie jar is
 * modelled by hand (`jar`), because every tab of one browser shares the
 * same `refresh_token` cookie: that is what the scenarios below are
 * about.
 *
 * What the server does today (and these specs pin):
 *   • the refresh token is a stateless 7-day JWT. There is no token
 *     table, no rotation family and no reuse detection, so parallel
 *     refreshes and a refresh with a token another tab already
 *     replaced all succeed (scenarios 1 and 3 cannot log anyone out on
 *     the server side);
 *   • logout clears the cookie, and the next refresh answers 401;
 *   • the server cannot tell tabs apart: after user B signs in on the
 *     same browser, a refresh from user A's tab returns B's token
 *     (scenario 2). The web client has to notice that (see
 *     apps/web/src/api/bm2-32-refresh.spec.ts);
 *   • every place that writes the refresh cookie (login, refresh,
 *     logout, the SSO callback) uses the same name / path / SameSite /
 *     Secure. The SSO callback used to write SameSite=Strict, which a
 *     cross-site deployment (web and API on different up.railway.app
 *     subdomains) never sends back on POST /auth/refresh.
 */
jest.mock('openid-client', () => ({
  discovery: jest.fn(async () => ({})),
  authorizationCodeGrant: jest.fn(async () => ({
    claims: () => ({ oid: 'oid-1', email: 'dana@amec.co.il', tid: 'tenant-1', name: 'Dana Levi' }),
  })),
}));
jest.mock('./oidc/oidc-flow-cookie.util', () => ({
  readSignedFlowCookie: jest.fn(() => ({
    state: 's', nonce: 'n', codeVerifier: 'v', provider: 'microsoft', redirectUri: 'x', createdAt: Date.now(),
  })),
  clearFlowCookie: jest.fn(),
  setSignedFlowCookie: jest.fn(),
}));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as bcrypt from 'bcrypt';

import { MemoryDb, memoryPrisma, PLANWISE_RELATIONS } from '../../testing/memory-prisma';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { RefreshStrategy } from './strategies/refresh.strategy';
import { OidcController } from './oidc/oidc.controller';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './refresh-cookie';

const ACCESS_SECRET = 'a'.repeat(32);
const REFRESH_SECRET = 'b'.repeat(32);
const PASSWORD = 'Correct-horse-1';

const RELATIONS = {
  ...PLANWISE_RELATIONS,
  user: {
    ...PLANWISE_RELATIONS.user,
    userRoles: { model: 'userRole', from: 'id', to: 'userId', many: true },
  },
  userRole: { role: { model: 'role', from: 'roleId', to: 'id' } },
  role: { roleModules: { model: 'roleModule', from: 'id', to: 'roleId', many: true } },
  roleModule: { module: { model: 'module', from: 'moduleId', to: 'id' } },
};

/** One browser: the cookie jar every tab shares. */
interface Jar {
  refresh: string | null;
}

/** `refresh_token=...; Path=/; ...` → parsed attributes (lower-cased keys). */
function parseSetCookie(header: string): { name: string; value: string; attrs: Record<string, string | true> } {
  const [pair, ...rest] = header.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const attrs: Record<string, string | true> = {};
  for (const part of rest) {
    const i = part.indexOf('=');
    if (i === -1) attrs[part.toLowerCase()] = true;
    else attrs[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attrs };
}

function refreshCookieOf(res: request.Response) {
  const raw = ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);
  const found = raw.map(parseSetCookie).find((c) => c.name === REFRESH_COOKIE_NAME);
  return found ?? null;
}

/** Apply a response's Set-Cookie to the jar the way a browser does. */
function store(jar: Jar, res: request.Response) {
  const c = refreshCookieOf(res);
  if (!c) return;
  const expired = c.attrs['expires'] && new Date(String(c.attrs['expires'])).getTime() <= Date.now();
  jar.refresh = expired || c.value === '' ? null : c.value;
}

const subOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub as number;

describe('BM2-32 refresh flow (HTTP, real auth stack over memory Prisma)', () => {
  let app: INestApplication;
  let db: MemoryDb;
  let jwt: JwtService;
  let realNow: () => number;
  let clockOffset = 0;

  beforeAll(async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    db = new MemoryDb(RELATIONS, {
      role: [{ id: 3, name: 'Professonal' }],
      roleModule: [],
      module: [],
      userRole: [],
      orgAuthConfig: [],
      user: [
        { id: 101, email: 'assaf@amec.co.il', firstName: 'Assaf', lastName: 'Chen', password: hash, roleId: 3, isActive: true, deletedAt: null, allowPasswordLogin: true, mustChangePassword: false },
        { id: 102, email: 'liat@amec.co.il', firstName: 'Liat', lastName: 'Peretz', password: hash, roleId: 3, isActive: true, deletedAt: null, allowPasswordLogin: true, mustChangePassword: false },
      ],
    });
    const config = {
      get: (key: string, def?: string) =>
        ({ JWT_ACCESS_SECRET: ACCESS_SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET } as Record<string, string>)[key] ?? def,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: '1h' } })],
      controllers: [AuthController],
      providers: [
        AuthService,
        LocalStrategy,
        JwtStrategy,
        RefreshStrategy,
        { provide: PrismaService, useValue: memoryPrisma(db) },
        { provide: ConfigService, useValue: config },
        { provide: NotificationsService, useValue: { sendEmail: jest.fn(async () => true) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // JWT `iat` has one-second resolution: move the clock forward so a
    // token minted "a moment later" really is a different token.
    realNow = Date.now.bind(Date);
    clockOffset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const http = () => request(app.getHttpServer());
  const login = async (jar: Jar, email: string) => {
    const res = await http().post('/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    store(jar, res);
    return res.body.accessToken as string;
  };
  const refresh = (jar: Jar, cookie = jar.refresh) => {
    const req = http().post('/auth/refresh');
    return cookie ? req.set('Cookie', `${REFRESH_COOKIE_NAME}=${cookie}`) : req;
  };

  it('scenario 3: five requests hit an expired access token at once, five parallel refreshes with the same cookie all succeed for the same user', async () => {
    const jar: Jar = { refresh: null };
    await login(jar, 'assaf@amec.co.il');
    const cookie = jar.refresh!;
    clockOffset = 61 * 60 * 1000; // the 1h access token has expired

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => refresh(jar, cookie)));

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(subOf(res.body.accessToken)).toBe(101);
      expect(refreshCookieOf(res)?.value).toBeTruthy();
    }
    // No reuse detection: the cookie the five shared is still accepted afterwards.
    expect((await refresh(jar, cookie)).status).toBe(200);
  });

  it('scenario 1: tab B refreshes with the cookie value tab A replaced a moment ago (two tabs, same user) and still gets a token', async () => {
    const jar: Jar = { refresh: null };
    await login(jar, 'assaf@amec.co.il');
    const seenByTabB = jar.refresh!;

    clockOffset = 5_000;
    const tabA = await refresh(jar);
    expect(tabA.status).toBe(200);
    store(jar, tabA);
    expect(jar.refresh).not.toBe(seenByTabB); // tab A rotated the cookie

    clockOffset = 6_000;
    const tabB = await refresh(jar, seenByTabB);
    expect(tabB.status).toBe(200);
    expect(subOf(tabB.body.accessToken)).toBe(101);
  });

  it('logout clears the cookie with the attributes login set it with, and the next refresh is a definitive 401', async () => {
    const jar: Jar = { refresh: null };
    const access = await login(jar, 'assaf@amec.co.il');
    const loginCookie = refreshCookieOf(await http().post('/auth/login').send({ email: 'assaf@amec.co.il', password: PASSWORD }))!;

    const out = await http().post('/auth/logout').set('Authorization', `Bearer ${access}`);
    expect(out.status).toBe(200);
    const cleared = refreshCookieOf(out)!;
    expect(cleared.value).toBe('');
    for (const attr of ['path', 'samesite', 'secure', 'httponly']) {
      expect(cleared.attrs[attr]).toEqual(loginCookie.attrs[attr]);
    }
    store(jar, out);
    expect(jar.refresh).toBeNull();

    const after = await refresh(jar);
    expect(after.status).toBe(401);
  });

  it('scenario 2: user B signs in on the same browser, so a refresh from user A\'s tab now answers with B\'s token (the server cannot tell tabs apart)', async () => {
    const jar: Jar = { refresh: null };
    const tabAToken = await login(jar, 'assaf@amec.co.il');
    expect(subOf(tabAToken)).toBe(101);

    // Tab B: sign out, sign in as Liat. One cookie jar, so tab A's cookie is gone.
    const out = await http().post('/auth/logout').set('Authorization', `Bearer ${tabAToken}`);
    store(jar, out);
    clockOffset = 2_000;
    await login(jar, 'liat@amec.co.il');

    // Tab A's access token expires later; its refresh carries the shared cookie.
    clockOffset = 61 * 60 * 1000;
    const res = await refresh(jar);
    expect(res.status).toBe(200);
    expect(subOf(res.body.accessToken)).toBe(102);
  });

  it('a refresh token signed with the wrong secret, or past its 7 days, is a 401 (not a 5xx)', async () => {
    const forged = jwt.sign({ sub: 101, email: 'assaf@amec.co.il', roleId: 3 }, { secret: 'x'.repeat(32), expiresIn: '7d' });
    expect((await refresh({ refresh: forged })).status).toBe(401);

    const jar: Jar = { refresh: null };
    await login(jar, 'assaf@amec.co.il');
    clockOffset = 8 * 24 * 60 * 60 * 1000;
    expect((await refresh(jar)).status).toBe(401);
  });

  it('a deactivated user cannot refresh (401), so the web client logs him out', async () => {
    const jar: Jar = { refresh: null };
    await login(jar, 'liat@amec.co.il');
    db.table('user').find((u) => u.id === 102)!.isActive = false;
    try {
      expect((await refresh(jar)).status).toBe(401);
    } finally {
      db.table('user').find((u) => u.id === 102)!.isActive = true;
    }
  });

  describe('one refresh cookie, written the same way everywhere', () => {
    it('login and refresh write the same name, path, SameSite, Secure, httpOnly and a 7-day lifetime', async () => {
      const jar: Jar = { refresh: null };
      const loginRes = await http().post('/auth/login').send({ email: 'assaf@amec.co.il', password: PASSWORD });
      store(jar, loginRes);
      const refreshRes = await refresh(jar);
      const a = refreshCookieOf(loginRes)!;
      const b = refreshCookieOf(refreshRes)!;
      for (const c of [a, b]) {
        expect(c.attrs['path']).toBe('/');
        expect(c.attrs['httponly']).toBe(true);
        expect(c.attrs['max-age']).toBe(String(7 * 24 * 60 * 60));
      }
      expect(b.attrs['samesite']).toBe(a.attrs['samesite']);
      expect(b.attrs['secure']).toBe(a.attrs['secure']);
    });

    it('cross-site deployments (anything but NODE_ENV=development) get SameSite=None; Secure, local dev gets Lax', () => {
      const env = { node: process.env.NODE_ENV, cross: process.env.AUTH_CROSS_SITE };
      try {
        delete process.env.AUTH_CROSS_SITE;
        process.env.NODE_ENV = 'staging';
        expect(refreshCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: 'none', path: '/' });
        process.env.NODE_ENV = 'development';
        expect(refreshCookieOptions()).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
        process.env.AUTH_CROSS_SITE = 'true';
        expect(refreshCookieOptions()).toMatchObject({ secure: true, sameSite: 'none' });
      } finally {
        process.env.NODE_ENV = env.node;
        if (env.cross === undefined) delete process.env.AUTH_CROSS_SITE;
        else process.env.AUTH_CROSS_SITE = env.cross;
      }
    });

    it('the SSO callback writes the refresh cookie exactly like /auth/login (it used to write SameSite=Strict, never sent back cross-site)', async () => {
      const env = process.env.NODE_ENV;
      process.env.NODE_ENV = 'staging';
      try {
        const cookies: Array<{ name: string; value: string; options: any }> = [];
        const res: any = {
          cookie: (name: string, value: string, options: any) => cookies.push({ name, value, options }),
          redirect: jest.fn(),
        };
        const auth = { login: jest.fn(async () => ({ accessToken: 'acc', refreshToken: 'ref', user: {} })) };
        const prisma = { orgAuthConfig: { findFirst: jest.fn(async () => ({ provider: 'microsoft', tenantId: 'tenant-1', clientId: 'c', allowedDomains: null, defaultRoleId: 3 })) } };
        const controller = new OidcController(
          prisma as any,
          { decrypt: () => 'secret' } as any,
          { write: jest.fn(async () => undefined) } as any,
          auth as any,
          { resolveUser: jest.fn(async () => ({ user: { id: 101, email: 'dana@amec.co.il' }, wasCreated: false, wasLinked: false })) } as any,
          { issuerUrlFor: () => 'https://login.example.test/tenant-1/v2.0' } as any,
        );
        const req: any = { headers: { host: 'api.test' }, protocol: 'https', query: { code: 'c', state: 's' } };

        await controller.microsoftCallback(req, res);

        const refreshCookie = cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!;
        expect(refreshCookie.value).toBe('ref');
        expect(refreshCookie.options).toEqual({ ...refreshCookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 });
        expect(refreshCookie.options.sameSite).toBe('none');
        expect(refreshCookie.options.secure).toBe(true);
      } finally {
        process.env.NODE_ENV = env;
      }
    });
  });
});
