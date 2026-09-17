# Planwise — Auth / Logout / Project-Load Wedge: Root-Cause Deep-Dive

**Owner:** Yulian · **Author:** analyst/reviewer · **For:** CC · **Date:** 2026-09-17
**Status:** OPEN — highest priority. This is the blocker that made the whole QA round unreliable ("the system kept crashing on us so the tests didn't run" — Danielle, transcript 0:50).

> This document is deliberately **not** another guess. My earlier migration/killswitch hypotheses were asserted with too much confidence. This is an *investigation protocol*: instrument, reproduce, capture the real error, then fix. Do not close any item on a green build or a code-path read — only on a captured runtime signal on staging.

---

## 1. Symptoms (observed, dated)

From the BM meeting (Sep 16–17) and the QA3 sheet:

1. **Refresh kicks users out.** Plain `F5` logs Danielle out repeatedly; **`Shift+F5` (hard reload) works *better*** ("it refreshes all the memory" — Danielle 53:03). *This asymmetry is the single most diagnostic clue we have.*
2. **"First click fails, second click works."** Tzlil, multiple times (7:37, 50:15): an action errors, retrying the same action seconds later succeeds.
3. **Specific projects fail to load / kick you out; others are fine.** Baer Yaakov **1660** and Baer Yarkon consistently fail; **Carmei Modiin loads fine** (54:31–55:20). Yulian: "we did a lot of context migrations" (54:44).
4. **Login itself sometimes refused** — "communication error / Unable to connect" (PR-030, now marked אושר but checklist item 29 SSO = **FAIL**, item 32 refresh-logout = **FAIL**).
5. **Not correlated to who clicked what** — Yulian confirmed two users acting simultaneously shouldn't be linked (6:31), yet outages hit both testers at once at some moments and only one at others.
6. **Yulian's own session stays up** while testers drop (6:48, 55:20).

## 2. Working theory: this is TWO distinct failures wearing one costume

Users experience everything as "it threw me out," but the evidence splits cleanly:

### Failure A — Auth refresh race / retry-queue bug (intermittent, any screen)
Explains symptoms 1, 2, 4, 6.
- Access token lives **in memory**; refresh token is an httpOnly cookie. On `F5` the in-memory token is gone; the app must silently refresh from the cookie before the first data call. If that bootstrap refresh races the first API call (or the axios refresh-retry interceptor refreshes but **doesn't replay** the original request, or fires **N concurrent refreshes** and all but one get a rotated/!invalidated token), the user sees a failure and gets bounced.
- **"Second click works"** is the signature of *refresh-then-don't-retry*: the refresh succeeded as a side effect, so the manual retry now carries a good token.
- **`Shift+F5` working better** points at a **stale cached JS bundle / service worker**: a hard reload fetches a fresh `index.html` + hashed bundle, bypassing a cached older bundle whose interceptor has the bug (or points at an old cookie/flag). If a service worker is registered, this is very likely a contributor.
- **Yulian stays up** because his token hadn't expired in his session window / his bundle was fresh.

### Failure B — Data-triggered stall on specific migrated projects (deterministic, per-project)
Explains symptoms 3, 5, and plausibly the recurring **WedgeKillswitch** deaths.
- Baer Yaakov 1660 / Baer Yarkon are *old, migrated* projects. If the project-load query hits malformed/orphaned rows from a migration (null FKs, dangling zone/deliverable/service links, a cyclic or unbounded include), the request can **500** or **hang**. A hang on a hot path stalls the event loop → the watchdog SIGKILLs the process → **the whole API goes down → every user is logged out at once** (symptom 5's "both at the same time"). That would explain why the wedge recurs with *healthy* idle vitals right up until the kill: the killing request is the one that never returns.
- This reframes the wedge from "false-firing killswitch on idle" (my earlier guess) to a **possible real stall triggered by opening a bad project**. That is testable and, if true, far more actionable.

These are not mutually exclusive — fix both. But **B is likely the trigger for the mass outages**, and A is the constant low-grade bleed.

## 3. Investigation protocol (do these in order; capture artifacts)

### Step 0 — Ship the instrumentation commit first (already greenlit)
Synchronous `process.stderr.write` on `SIGTERM`/`SIGINT`/`exit`/`beforeExit`, vitals cadence 30s→5s. Without this we're blind on the next wedge. **Add one more line:** a request-scoped log at the *start* and *end* of every request with a request-id, method, path, projectId (if present), and duration — so the last un-ended request before a kill is visible in the stderr stream.

### Step 1 — Correlate wedge deaths with project access (tests Failure B)
- From the request-in/request-out logs: **which request was in-flight (started, never ended) at each SIGKILL?** Hypothesis passes if it's disproportionately a `GET /projects/1660...` (or its zones/deliverables/tasks sub-calls).
- Immediately reproduce out-of-band: on staging, `curl -w '%{time_total} %{http_code}'` (server-side, from CC's own machine/Railway shell — not via the restricted WebFetch) the load endpoints for **1660 and Baer Yarkon vs Carmei Modiin**. A bad project will 500 or hang (watch `time_total` climb toward the ~30s watchdog window).

### Step 2 — DB integrity scan of migrated projects (tests Failure B root)
Run read-only integrity queries against the migrated projects (start with 1660):
- Orphaned FKs: tasks→deliverable, deliverable→zone, deliverable→service, zone→project, assignments→person, where the referenced row is missing.
- Nulls in columns the load path assumes non-null.
- Duplicate/instance rows (ties to **PR-041** duplicate deliverables in Execution — may be the same corruption).
- Compare row shapes 1660 vs a clean new project. **The delta is the bug.**

### Step 3 — Trace the auth bootstrap + interceptor (tests Failure A)
- In `apps/web`, read the axios refresh interceptor: does it (a) queue concurrent 401s and replay them after a single refresh, or does it fire multiple refreshes? (b) actually **retry the original request** after refresh, or just refresh and let the first call die?
- Check the app bootstrap: on load, is there a guaranteed `await refresh()` **before** the first authenticated call, or a race?
- **Service worker / cache:** is one registered? What are the `Cache-Control` headers on `index.html` and the hashed bundles? A cached `index.html` pointing at an old bundle would exactly produce the `F5`-bad / `Shift+F5`-good split. If a SW exists and isn't needed, plan its removal + a one-time unregister.
- Confirm the cross-site cookie fix (2cadd61, `SameSite=None; Secure`) is actually **live on staging** (Set-Cookie header on `/auth/login` and `/auth/refresh` responses) — verify in the network tab, not just in code.

### Step 4 — Reproduction matrix (attach results)
| Case | Steps | Expected if A | Expected if B |
|---|---|---|---|
| Fresh login → wait past access-token TTL → click | one action | 1st fails / 2nd works | n/a |
| Logged in → plain `F5` | reload | bounced to login | fine |
| Logged in → `Shift+F5` | hard reload | fine (stale bundle bypassed) | fine |
| Open project 1660 | navigate | fine | hang/500, maybe mass outage |
| Open Carmei Modiin | navigate | fine | fine |
| Two users act simultaneously | concurrent | independent | both drop iff a wedge fires |

## 4. Likely fixes (do not implement until the step above confirms each)
- **A:** single-flight refresh with a request queue that replays the original requests; guaranteed bootstrap refresh before first authed call; correct cross-site cookie live; if a stale-bundle/SW is confirmed — `Cache-Control: no-cache` on `index.html`, unregister the SW, cache-bust.
- **B:** repair the migrated data (targeted backfill/cleanup migration for orphaned FKs); **and** harden the load path so one bad project can never stall the loop — bounded/defensive includes, timeouts on hot queries, and a query that returns a clean error instead of hanging. Data fix + code guard, not either alone.

## 5. Definition of Done (runtime, on staging)
1. Instrumentation live; the next wedge (if any) shows a captured signal (signal received? which request was in-flight?).
2. Failure B: 1660 and Baer Yarkon load in < 2s with HTTP 200, verified by server-side timing; integrity scan returns zero orphans for all migrated projects.
3. Failure A: token-expiry → single action succeeds on the **first** click (no "second click" workaround); plain `F5` keeps the session; checklist **item 32 passes** and **item 29 (SSO) passes**, verified live by Danielle + Tzlil, not by CC alone.
4. A 30-minute active multi-user session on staging with **zero** unexpected logouts.

## 6. Reservations to surface before/while fixing
- If Failure B is real, **existing production/staging data may need a cleanup migration** — that is data-mutating; get explicit sign-off and a backup before running it.
- Removing/altering a service worker affects every already-loaded client once; plan the one-time unregister carefully.
- Don't let "SSO login FAIL" (item 29) get lumped in blindly — capture whether it's the Entra path, the Google path, or both, and the exact error, before touching it.
