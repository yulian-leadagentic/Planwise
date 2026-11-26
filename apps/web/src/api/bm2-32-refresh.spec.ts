/**
 * QA6 package 11, BM2-32 (2026-11-26): "No mid-work logout on a
 * transient refresh blip".
 *
 * Each tab is its own copy of the real modules (`vi.resetModules()` per
 * tab: its own auth store, axios client, refresh lock and cross-tab
 * sync), its own `window` / `sessionStorage`, and one `localStorage` and
 * one refresh cookie for the whole browser, like a real browser. The API
 * is a fake axios adapter that behaves like the real one
 * (apps/api/src/modules/auth/bm2-32-refresh-flow.spec.ts pins that):
 * stateless refresh, the cookie follows the last sign-in, logout clears
 * it.
 *
 * Scenarios the owner asked for:
 *   1. two tabs, same user;
 *   2. two tabs, different users (a sign-in in one tab replaces the
 *      cookie of the other);
 *   3. the access token expires while several requests are in flight;
 *   4. a short network drop while refreshing (network error, 502,
 *      timeout), mid-session and on page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';

vi.mock('@sentry/react', () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/notify', () => ({
  notify: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), apiError: vi.fn() },
  getErrorCode: () => undefined,
  getErrorMessage: () => undefined,
}));

const PASSWORD = 'pw';
const NOTICE_KEY = 'planwise.auth_notice';
const FLAG_KEY = 'planwise.was_authenticated';

interface Account {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
}
const ASSAF: Account = { id: 101, email: 'assaf@amec.co.il', firstName: 'Assaf', lastName: 'Chen' };
const LIAT: Account = { id: 102, email: 'liat@amec.co.il', firstName: 'Liat', lastName: 'Peretz' };

type Failure = 'network' | 'timeout' | 502 | 503;

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const subOf = (jwt: string | null | undefined): number | null => {
  if (!jwt) return null;
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;
  } catch {
    return null;
  }
};
const headerOf = (config: any, name: string): string | undefined =>
  config.headers?.get?.(name) ?? config.headers?.[name] ?? undefined;

/** The API as the browser sees it. */
class FakeApi {
  accounts = [ASSAF, LIAT];
  /** The browser's httpOnly refresh cookie: one jar for every tab. */
  cookie: Account | null = null;
  live = new Set<string>();
  minted = 0;
  refreshCalls = 0;
  refreshTimeouts: Array<number | undefined> = [];
  /** The next refreshes fail like this, in order (then succeed again). */
  refreshFailures: Failure[] = [];
  requests: Array<{ method: string; url: string; as: number | null; status: number }> = [];
  private gates = new Map<string, Promise<void>>();

  mint(a: Account): string {
    const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: a.id, email: a.email, n: ++this.minted })}.sig`;
    this.live.add(token);
    return token;
  }

  expireAccessTokens() {
    this.live.clear();
  }

  /** Hold the response to `url` until the returned function is called. */
  hold(url: string): () => void {
    let release!: () => void;
    this.gates.set(url, new Promise<void>((r) => (release = r)));
    return () => release();
  }

  adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/api\/v1/, '');
    const method = String(config.method ?? 'get').toUpperCase();
    const respond = (status: number, data: unknown) => {
      const response = { data, status, statusText: String(status), headers: {}, config, request: {} };
      if (status >= 200 && status < 300) return response;
      throw new AxiosError(`Request failed with status code ${status}`, status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, {}, response as any);
    };
    await Promise.resolve();

    if (url === '/auth/refresh') {
      this.refreshCalls++;
      this.refreshTimeouts.push(config.timeout);
      const failure = this.refreshFailures.shift();
      if (failure === 'network') throw new AxiosError('Network Error', 'ERR_NETWORK', config, {});
      if (failure === 'timeout') throw new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config, {});
      if (failure) return respond(failure, '<html>Bad Gateway</html>');
      if (!this.cookie) return respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      return respond(200, { success: true, data: { accessToken: this.mint(this.cookie) } });
    }

    if (url === '/auth/login') {
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
      const account = this.accounts.find((a) => a.email === body?.email);
      if (!account || body?.password !== PASSWORD) {
        return respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      }
      this.cookie = account;
      return respond(200, { success: true, data: { accessToken: this.mint(account), user: { ...account } } });
    }

    const gate = this.gates.get(url);
    if (gate) {
      this.gates.delete(url);
      await gate;
    }
    const auth = headerOf(config, 'Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const as = token && this.live.has(token) ? subOf(token) : null;
    if (as === null) {
      this.requests.push({ method, url, as: null, status: 401 });
      return respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
    if (url === '/auth/logout') this.cookie = null;
    this.requests.push({ method, url, as, status: 200 });
    return respond(200, { success: true, data: { as } });
  };
}

class FakeStorage {
  map = new Map<string, string>();
  constructor(private onChange?: (key: string, oldValue: string | null, newValue: string | null) => void) {}
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    const old = this.getItem(key);
    this.map.set(key, String(value));
    this.onChange?.(key, old, String(value));
  }
  removeItem(key: string) {
    const old = this.getItem(key);
    if (old === null) return;
    this.map.delete(key);
    this.onChange?.(key, old, null);
  }
  clear() {
    this.map.clear();
  }
}

interface Tab {
  name: string;
  window: any;
  session: FakeStorage;
  /** Full-page navigations this tab asked the browser for. */
  nav: string[];
  client: any;
  store: any;
  refreshLock: any;
  sync: any | null;
  stopSync?: () => void;
}

let api: FakeApi;
let local: FakeStorage;
let tabs: Tab[];
let current: Tab | null;
let storageEvents: Array<{ from: Tab | null; key: string; oldValue: string | null; newValue: string | null }>;

function makeLocation(path: string, nav: string[]) {
  const loc: any = { pathname: path, search: '', hash: '', origin: 'https://web.test' };
  const go = (url: string) => {
    nav.push(url);
    loc.pathname = new URL(url, 'https://web.test').pathname;
  };
  loc.assign = go;
  loc.replace = go;
  loc.reload = () => nav.push('(reload)');
  Object.defineProperty(loc, 'href', { get: () => `https://web.test${loc.pathname}`, set: go });
  return loc;
}

/** Make `tab` the one whose code is running (its window + sessionStorage). */
function enter(tab: Tab) {
  current = tab;
  (globalThis as any).window = tab.window;
  (globalThis as any).sessionStorage = tab.session;
}

async function settle() {
  for (let i = 0; i < 25; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((r) => setImmediate(r));
  }
}

/** A new tab (or a reload of `replacing`): fresh modules, as after a page load. */
async function openTab(name: string, path = '/', replacing?: Tab): Promise<Tab> {
  const nav: string[] = replacing?.nav ?? [];
  const win: any = replacing?.window ?? new EventTarget();
  if (!replacing) win.location = makeLocation(path, nav);
  replacing?.stopSync?.();
  const tab: Tab = { name, window: win, session: replacing?.session ?? new FakeStorage(), nav, client: null, store: null, refreshLock: null, sync: null };
  enter(tab);
  vi.resetModules();
  const axios = (await import('axios')).default;
  axios.defaults.adapter = api.adapter;
  tab.client = (await import('./client')).default;
  tab.client.defaults.adapter = api.adapter;
  tab.store = (await import('@/stores/auth.store')).useAuthStore;
  tab.refreshLock = await import('./refresh-lock');
  // In the app, AuthBootstrap starts the cross-tab sync on mount.
  tab.sync = await import('./auth-sync');
  tab.stopSync = tab.sync.startAuthSync(win);
  tabs = tabs.filter((t) => t !== replacing).concat(tab);
  return tab;
}

/** What AuthBootstrap does on page load. */
async function boot(tab: Tab) {
  enter(tab);
  if (!tab.store.getState().isBootstrapping) return;
  await tab.sync.bootstrapSession();
  await settle();
}

/** What useLogin does. */
async function signIn(tab: Tab, account: Account) {
  enter(tab);
  const res = await tab.client.post('/auth/login', { email: account.email, password: PASSWORD });
  tab.store.getState().setAuth(res.data.data.accessToken, res.data.data.user);
  await settle();
}

/** What useLogout does. */
async function signOut(tab: Tab) {
  enter(tab);
  await tab.client.post('/auth/logout').catch(() => undefined);
  tab.store.getState().clearAuth();
  await settle();
}

async function inTab<T>(tab: Tab, fn: () => Promise<T>): Promise<T> {
  enter(tab);
  const out = await fn();
  await settle();
  return out;
}

/** The browser fires `storage` in every other tab of the origin. */
async function deliverStorageEvents() {
  const events = storageEvents.splice(0);
  for (const e of events) {
    for (const tab of [...tabs]) {
      if (tab === e.from) continue;
      enter(tab);
      const ev = new Event('storage');
      Object.assign(ev, { key: e.key, oldValue: e.oldValue, newValue: e.newValue });
      tab.window.dispatchEvent(ev);
      await settle();
    }
  }
}

const userOf = (tab: Tab) => subOf(tab.store.getState().accessToken);
const noticeOf = (tab: Tab) => tab.session.getItem(NOTICE_KEY);

beforeEach(() => {
  api = new FakeApi();
  tabs = [];
  current = null;
  storageEvents = [];
  local = new FakeStorage((key, oldValue, newValue) => storageEvents.push({ from: current, key, oldValue, newValue }));
  (globalThis as any).localStorage = local;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const t of tabs) t.stopSync?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

describe('scenario 3: the access token expires while several requests are in flight', () => {
  it('five parallel 401s share ONE refresh and are all replayed as the same user', async () => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    api.expireAccessTokens();

    const urls = ['/projects', '/tasks/mine', '/notifications', '/dashboard', '/me/time'];
    const results = await inTab(tab, () => Promise.all(urls.map((u) => tab.client.get(u))));

    expect(api.refreshCalls).toBe(1);
    expect(results.map((r: any) => r.data.data.as)).toEqual([101, 101, 101, 101, 101]);
    expect(tab.nav).toEqual([]);
    expect(userOf(tab)).toBe(101);
  });

  it('a 401 that comes back after the refresh already finished is replayed with the new token, no second refresh', async () => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    api.expireAccessTokens();

    enter(tab);
    const release = api.hold('/slow');
    const slow = tab.client.get('/slow');
    const fast = await tab.client.get('/fast');
    expect(fast.data.data.as).toBe(101);
    expect(api.refreshCalls).toBe(1);

    release();
    const late = await slow;
    expect(late.data.data.as).toBe(101);
    expect(api.refreshCalls).toBe(1);
  });
});

describe('scenario 1: two tabs, same user', () => {
  it('tab B refreshing (and replacing the cookie) does not disturb tab A', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);
    expect(userOf(b)).toBe(101);

    api.expireAccessTokens();
    await inTab(b, () => b.client.get('/projects'));
    const res = await inTab(a, () => a.client.get('/projects'));

    expect(res.data.data.as).toBe(101);
    expect(a.nav).toEqual([]);
    expect(b.nav).toEqual([]);
  });

  it('tab B signs out: tab A is signed out right away with a note, not at its next token expiry in the middle of work', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);

    await signOut(b);
    await deliverStorageEvents();

    expect(a.store.getState().isAuthenticated).toBe(false);
    expect(a.nav).toEqual(['/login']);
    expect(noticeOf(a)).toBe('You signed out in another tab.');
  });

  it('a sign-out in tab B whose logout request failed (cookie still valid) does not throw tab A out', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);

    enter(b);
    b.store.getState().clearAuth(); // the POST /auth/logout never reached the API
    await settle();
    await deliverStorageEvents();

    expect(a.store.getState().isAuthenticated).toBe(true);
    expect(userOf(a)).toBe(101);
    expect(a.nav).toEqual([]);
  });
});

describe('scenario 2: two tabs, different users on one browser', () => {
  it('tab B signs out and signs in as Liat: tab A follows to the sign-in page (with a note), then into Liat\'s account', async () => {
    let a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);

    await signOut(b);
    await deliverStorageEvents();
    expect(a.nav).toEqual(['/login']);
    expect(noticeOf(a)).toBe('You signed out in another tab.');

    a = await openTab('A', '/login', a); // the page load that navigation caused
    await boot(a);
    await signIn(b, LIAT);
    await deliverStorageEvents();

    expect(userOf(a)).toBe(102);
    expect(a.store.getState().isAuthenticated).toBe(true);
  });

  it('if tab A missed the sign-in, its next refresh notices the cookie is now Liat\'s: it does not replay Assaf\'s request as Liat, and reloads into Liat with a note', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    // Tab B (events not delivered to A): sign out, sign in as Liat.
    const b = await openTab('B');
    await boot(b);
    await signOut(b);
    await signIn(b, LIAT);
    storageEvents.length = 0;

    api.expireAccessTokens();
    enter(a);
    const save = a.client.post('/time-entries', { minutes: 60 });
    await expect(save).rejects.toBeTruthy();
    await settle();

    expect(api.requests.filter((r) => r.url === '/time-entries' && r.as === 102)).toEqual([]);
    expect(a.nav).toEqual(['(reload)']);
    expect(noticeOf(a)).toBe('You signed in as liat@amec.co.il in another tab. This tab now uses that account.');
  });

  it('tab A (Assaf) that only hears about the sign-in as Liat reloads into Liat with a note', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);
    await signOut(b);
    storageEvents.length = 0; // tab A missed the sign-out

    await signIn(b, LIAT);
    await deliverStorageEvents();

    expect(a.nav).toEqual(['(reload)']);
    expect(noticeOf(a)).toBe('You signed in as liat@amec.co.il in another tab. This tab now uses that account.');
    expect(a.store.getState().isAuthenticated).toBe(false); // nothing of Assaf's session is kept for the reload
  });

  it('a sign-out signal that arrives during a network blip keeps the session (the next refresh decides)', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);

    await signOut(b);
    api.refreshFailures = ['network'];
    await deliverStorageEvents();

    expect(a.store.getState().isAuthenticated).toBe(true);
    expect(a.nav).toEqual([]);
  });

  it('tab B (now Liat) ignores an "ended" signal from a tab whose refresh fell between the sign-out and the sign-in', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B');
    await boot(b);
    await signOut(b);
    storageEvents.length = 0;

    // Tab A refreshes in the gap: the cookie is gone, a definitive 401.
    api.expireAccessTokens();
    await inTab(a, () => a.client.get('/projects').catch(() => undefined));
    expect(a.nav).toEqual(['/login']);
    const fromA = storageEvents.splice(0);

    await signIn(b, LIAT);
    storageEvents.length = 0;
    storageEvents.push(...fromA); // ...delivered late, after Liat signed in
    await deliverStorageEvents();

    expect(b.store.getState().isAuthenticated).toBe(true);
    expect(userOf(b)).toBe(102);
    expect(b.nav).toEqual([]);
  });
});

describe('scenario 4: a short network drop while refreshing', () => {
  it('a blip (network error, then 502) is absorbed: the refresh is retried with backoff and the request succeeds', async () => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    api.expireAccessTokens();
    api.refreshFailures = ['network', 502];

    vi.useFakeTimers();
    enter(tab);
    const res = tab.client.get('/projects');
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(res).resolves.toMatchObject({ data: { data: { as: 101 } } });
    expect(api.refreshCalls).toBe(3);
    expect(tab.nav).toEqual([]);
    expect(tab.store.getState().isAuthenticated).toBe(true);
  });

  it('a longer outage: the request fails but the session is kept (no sign-out, no /login), and the next request recovers', async () => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    api.expireAccessTokens();
    api.refreshFailures = ['network', 'timeout', 503, 502, 'network', 'network'];

    vi.useFakeTimers();
    enter(tab);
    const res = tab.client.get('/projects');
    const settled = res.then(() => 'ok', (e: any) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await settled;
    expect(err).not.toBe('ok');
    expect(err.response?.status === 401).toBe(false);
    expect(tab.store.getState().isAuthenticated).toBe(true);
    expect(local.getItem(FLAG_KEY)).toBe('1');
    expect(tab.nav).toEqual([]);

    api.refreshFailures = [];
    const again = tab.client.get('/projects');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(again).resolves.toMatchObject({ data: { data: { as: 101 } } });
  });

  it('the refresh request has a timeout, so a hung connection cannot freeze the tab', async () => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    api.expireAccessTokens();
    await inTab(tab, () => tab.client.get('/projects'));
    expect(api.refreshTimeouts[0]).toBeGreaterThan(0);
  });

  it.each([401, 403])('only a definitive %i from refresh signs the user out (with a short explanation)', async (status) => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    api.expireAccessTokens();
    if (status === 401) api.cookie = null;
    else api.refreshFailures = [403 as any];

    await inTab(tab, () => tab.client.get('/projects').catch(() => undefined));

    expect(tab.store.getState().isAuthenticated).toBe(false);
    expect(tab.nav).toEqual(['/login']);
    expect(noticeOf(tab)).toBe('Your session has ended. Please sign in again.');
  });

  it('page load during a blip: keeps retrying (reconnecting) and signs in when the API is back, instead of showing the sign-in page', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    const b = await openTab('B', '/projects/40');
    expect(b.store.getState().isBootstrapping).toBe(true);
    api.refreshFailures = [502, 'network', 'timeout'];
    const retries: number[] = [];

    vi.useFakeTimers();
    enter(b);
    const outcome = b.sync.bootstrapSession({ onRetry: (n: number) => retries.push(n) });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toBe('authenticated');
    expect(retries).toEqual([1, 2, 3]);
    expect(userOf(b)).toBe(101);
    expect(b.store.getState().isBootstrapping).toBe(false);
    expect(b.nav).toEqual([]);
  });

  it('page load when the cookie is really gone (401): the sign-in page, and the "was signed in" flag is forgotten', async () => {
    const a = await openTab('A');
    await signIn(a, ASSAF);
    api.cookie = null;
    const b = await openTab('B');

    enter(b);
    const outcome = await b.sync.bootstrapSession();

    expect(outcome).toBe('signed-out');
    expect(b.store.getState()).toMatchObject({ isAuthenticated: false, isBootstrapping: false });
    expect(local.getItem(FLAG_KEY)).toBeNull();
  });
});

describe('401s that are not an expired access token', () => {
  it('a wrong password on the sign-in page does not call /auth/refresh and does not reload the page', async () => {
    const tab = await openTab('A', '/login');
    enter(tab);
    const err = await tab.client.post('/auth/login', { email: ASSAF.email, password: 'wrong' }).catch((e: any) => e);
    await settle();

    expect(err.response.status).toBe(401);
    expect(err.response.data.error.message).toBe('Invalid credentials');
    expect(api.refreshCalls).toBe(0);
    expect(tab.nav).toEqual([]);
  });

  it('after signing out in this tab, a late 401 does not refresh and does not reload', async () => {
    const tab = await openTab('A');
    await signIn(tab, ASSAF);
    await signOut(tab);
    const before = api.refreshCalls;

    await inTab(tab, () => tab.client.get('/projects').catch(() => undefined));

    expect(api.refreshCalls).toBe(before);
    expect(tab.nav).toEqual([]);
  });
});
