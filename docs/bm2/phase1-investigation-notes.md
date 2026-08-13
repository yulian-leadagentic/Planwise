# bm2 phase 1 — investigation notes

Findings for the items in `phase1-bugs.md` marked INVESTIGATE-ONLY.
A teammate has local WIP on the permissions / session layer, so nothing
here has been rewritten from this branch — the notes below are just
enough for that owner to land a fix without re-diagnosing.

---

## Item 6 · "Some users are invisible" (permissions / people list)

**Root cause candidate — strict `userType` equality in the list filter**

`apps/api/src/modules/users/users.service.ts:212`

```ts
if (query.userType) where.userType = query.userType;
```

The `UserType` enum (`apps/api/prisma/schema.prisma:12-16`) has THREE
values:

- `employee`
- `partner`
- **`both`**

The People page splits into two tabs that call this endpoint with:

- **Employees** tab → `?userType=employee`
- **External Employees** tab → `?userType=partner`

(`apps/web/src/features/people/people-page.tsx:241`)

Because the `where` clause is strict equality, users whose row was
seeded / imported with `userType='both'` are excluded from BOTH tabs —
they don't show as an employee OR as a partner. Amit Maimoni and
Daniel Malka are almost certainly `userType='both'` rows.

The same code path already knows about the "both" case elsewhere —
`users.service.ts:119` (`if (dto.userType === 'employee' || dto.userType === 'both')`
when syncing employment fields on update). And the sister query in
`apps/api/src/modules/execution-planning/execution-planning.service.ts:630`
uses the correct pattern:

```ts
userType: { in: ['employee', 'both'] },
```

**Recommended fix (for the permissions owner):** in
`users.service.ts:findAll`, translate `query.userType` before applying
it to `where`:

```ts
if (query.userType === 'employee') where.userType = { in: ['employee', 'both'] };
else if (query.userType === 'partner') where.userType = { in: ['partner', 'both'] };
else if (query.userType) where.userType = query.userType;
```

Anything that filters users by type against a strict enum value has the
same bug shape — worth grepping the API for other `userType:` writes
that don't use `in`. (I found only the two above in this pass;
mention-search, assignee pickers etc. call `/users` through the same
endpoint, so fixing `findAll` covers them.)

**Not the cause of "I don't see myself":** the `isActive` default in
`findAll` (defaults to `true` when unset) hides inactive users from
every picker but not from the People page's "all" filter. If a user
still can't see themselves after switching the People page's status
filter to "all", the second candidate is the `partners:read`
permission gate on `GET /users` (`users.controller.ts:65`) — a role
without that permission gets an empty list rather than a self-only
list. Leaving that for the permissions owner to look at alongside the
in-progress rewrite.

---

## Item 8 · "App throws the user out mid-work" (session / refresh / token)

Setup for the current auth flow:

- Access token — memory only in the frontend, JWT `expiresIn: '1h'`
  (`apps/api/src/modules/auth/auth.module.ts:29`).
- Refresh token — httpOnly cookie `refresh_token`, `expiresIn: '7d'`
  (`apps/api/src/modules/auth/auth.service.ts:101-104`), set with
  `sameSite: 'strict'` in three places
  (`auth.controller.ts:43`, `auth.controller.ts:58`,
  `oidc.controller.ts:254`).
- Interceptor at `apps/web/src/api/client.ts:37-97` catches 401s, calls
  `POST /auth/refresh`, retries the failed request. On refresh failure
  it does `clearAuth()` + `window.location.href = '/login'`.

Two concrete kick-out candidates, both worth eyeballing before the
teammate's rewrite lands:

### Candidate A · Interceptor kicks on ANY refresh failure

`apps/web/src/api/client.ts:81-89`

```ts
} catch (refreshError: any) {
  processQueue(refreshError, null);
  console.warn('[auth] refresh failed → redirecting to /login', …);
  useAuthStore.getState().clearAuth();
  window.location.href = '/login';
  return Promise.reject(refreshError);
}
```

`refreshError` is caught regardless of its cause. That means a
transient failure of `POST /auth/refresh` also boots the user:

- API down / restart → axios throws → caught → redirect to /login.
- CORS pre-flight failure (e.g. `Access-Control-Allow-Credentials`
  briefly wrong after a deploy) → caught → redirect.
- Any 5xx from the refresh endpoint (e.g. Prisma connection blip) →
  caught → redirect.

Only a 401 on refresh actually means "your session is invalid." A
safer catch would narrow to `refreshError?.response?.status === 401`
before clearing auth + redirecting; other errors should reject the
original request but keep the session so the next attempt can succeed.

**Recommended fix (small, safe to land alongside the permissions
rewrite):** switch the `catch` to only clear + redirect on
`status === 401` (and possibly 403). Other statuses → reject the
in-flight request, leave auth alone, let react-query retry.

### Candidate B · `sameSite: 'strict'` on the refresh cookie

Every `res.cookie('refresh_token', …)` uses `sameSite: 'strict'`. The
comment in `client.ts:62-69` — "The wrapping interceptor handles this
server-side, but if it ever yields a different shape, the old
`data.data.accessToken` line silently set the token to undefined and
the user got 'logged out' without ever seeing /login — the most
likely cause of the long-session kick-out reports." — points at a bug
that's already been fixed in the same file, so this specific vector
should be closed.

`sameSite: 'strict'` still bites in one situation the app cares about:
if the frontend and API are on different registrable domains (not just
different subdomains), the browser refuses to send the cookie on
cross-site XHR — including the `withCredentials: true` refresh call
from `auth-bootstrap.tsx:53`. On production Railway that's
`*.up.railway.app`, which lands on the Public Suffix List, so
`api.up.railway.app` and `app.up.railway.app` are actually **cross-site**
and the strict cookie will not fly. Same-origin dev
(`localhost:5173` + `localhost:3000`) is fine; a custom-domain
deploy (`app.planwise.co.il` + `api.planwise.co.il`) is fine
(shared eTLD+1); Railway-preview URLs are not.

**Recommended check:** confirm the production domain layout. If
frontend and API live on separate registrable domains, either put both
under one apex (same-site) or drop the refresh cookie to
`sameSite: 'lax'` (still safe — `POST /auth/refresh` is not vulnerable
to classic CSRF because the response is a token, not a state change,
and the cookie isn't inspectable by JS).

### Not the cause

- Roles-guard 403 (`apps/api/src/common/guards/roles.guard.ts:27,85`)
  is Forbidden, not Unauthorized — the interceptor does not react to
  it, so a permission-check failure doesn't log the user out.
- Refresh strategy validate() correctly re-checks
  `isActive: true` — a user deactivated by an admin gets a real 401
  on their next refresh, which is intended behavior.

No code change committed for this item — the safe fix is candidate A's
narrower catch (~4 lines), but per phase1-bugs.md guardrails item 8 is
investigate-only and the permissions/session owner may want to bundle
that with their in-progress work.

