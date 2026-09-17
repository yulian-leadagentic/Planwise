# Planwise QA3 — Instructions for CC

**From:** Yulian (via analyst/reviewer) · **Date:** 2026-09-17
**Read first (in the planwise project):** `claude/planwise-auth-wedge-deep-dive.md` and `claude/planwise-qa3-work-order.md`. This is the execution order for the first three units of work. Do them in sequence; **A → then report → then C**. B (the investigation) has no code changes beyond read-only queries — you report findings and wait for a go before fixing.

## Ground rules (every commit)
- **Verify-first:** before changing anything, read the actual code path and confirm the current behavior. State what you found.
- **Runtime DoD, not green-build:** an item is done only when verified live on staging with a captured signal (HTTP status, log line, or a tester confirming). Green build / "code path looks right" is not done. (This is the standard we agreed after the shallow-DoD miss.)
- **Surface reservations before coding.** If a fix has a risk (data mutation, shared-client impact, uncertain root cause), stop and flag it — don't push through.
- **Design system + dark mode:** any UI change follows the `planwise-design` skill and must look correct in dark mode.
- **One concern per commit**, clear messages, and report the exact files touched.

---

## COMMIT A — Wedge instrumentation (ship now, ~20 lines)
Goal: get a signal before the next wedge. No behavior change.
1. Synchronous handlers that bypass pino (use `process.stderr.write`):
   - `SIGTERM`, `SIGINT` → write `"received signal X @<ISO time>"`.
   - `process.on('exit', code => …)` → write `"exit code=<code> @<time>"`.
   - `process.on('beforeExit', …)`.
2. Bump the vitals cadence from 30s → 5s so last-known-good sits close to the death moment.
3. **Add request-scoped logging:** at request start and end, write one line with `reqId`, method, path, `projectId` (if any), and duration-ms. This is what tells us *which request was in-flight at the kill*.
Confirm all writes go to **stderr unconditionally** (not gated by log level) and that stderr shows in Railway's log stream. Deploy to staging.

**DoD:** the next wedge (if any) leaves either a signal line or a last-started-never-ended request line in the Railway logs.

---

## UNIT B — Auth/wedge investigation (read-only; report, do NOT fix yet)
Follow the deep-dive doc's protocol. Two hypotheses to test:

**B1 — Data-triggered stall on migrated projects (likely cause of mass outages).**
- From Commit-A logs, identify the in-flight request at each SIGKILL.
- Server-side (Railway shell / your own machine — **not** via the app), time the load endpoints: `curl -w '%{http_code} %{time_total}\n'` for **Baer Yaakov 1660** and **Baer Yarkon** vs **Carmei Modiin**. A bad project 500s or climbs toward the ~30s watchdog window.
- Read-only DB integrity scan on 1660 (then all migrated projects): orphaned FKs (task→deliverable, deliverable→zone, deliverable→service, zone→project, assignment→person), unexpected NULLs on the load path, duplicate/instance rows. Diff 1660 against a clean new project.

**B2 — Auth refresh race / stale bundle.**
- Read the axios refresh interceptor: does it single-flight refresh + **replay** the original request, or refresh-without-retry / fire N concurrent refreshes? ("second click works" = refresh-without-retry.)
- Bootstrap: is there a guaranteed `await refresh()` before the first authed call on load, or a race?
- **Service worker / cache:** is a SW registered? What are `Cache-Control` headers on `index.html` and the hashed bundles? (`F5` bad / `Shift+F5` good = stale bundle/SW.)
- Confirm the cross-site cookie fix (2cadd61) is **live**: check `Set-Cookie: …SameSite=None; Secure` on `/auth/login` and `/auth/refresh` responses in the network tab.

**Deliverable:** a short findings report — which hypothesis each symptom supports, the exact in-flight request/error, and a proposed fix per confirmed cause. **Wait for approval before the data-cleanup or SW changes** (both are risky: data mutation needs a backup + sign-off; SW removal hits every loaded client once).

---

## COMMIT C — Project Category binding + customer-block (independent; ship in parallel)
Covers PR-021, PR-037, PR-025, and the customer-select failure (transcript 17:29–18:45). Verify-first: confirm the dropdown currently reads a hardcoded enum, not the `projectCategory` table.
1. Bind the New-Project **Project Category** dropdown to the **custom Project Categories table** (GET categories; render name; **store by FK id**, not a string).
2. **Multi-select** categories (PR-037: e.g. מגורים + מסחר).
3. Fix the dependent "project rule types" fetch: an empty result must render an empty state and **never disable/block the customer field** or the form. (This is why customer became selectable only after removing the category + hard refresh.)
4. PR-025: **remove the "add organization" option** from New Project (organizations live only in Partners).
5. PR-022 wording (customer vs client): point the field at the correct entity; the **list content is Amit's** — don't invent it.

**DoD (live):** add a category in Types → it appears in New Project; multi-select persists on the created project; selecting any category never breaks the customer picker (customer selectable first try, no refresh); no "add organization" option in New Project. Confirmed by a tester.

---

## After these
Report back with: Commit A deployed, the Unit-B findings report, and Commit C verified. Then we sequence C2 (cost chain, starting PR-029) and C3/C4 (zone model + deliverable identity) from the work order. Do **not** use project 1660 as the cost test project until Unit B clears it.
