# Planwise QA3 — Status & Line-Up (single source of truth)

**Updated:** 2026-09-22 · by analyst, verified against the repo (`staging` branch) and CC's live runs.
**This doc supersedes the category section and the Failure-B section of `qa3-work-order.md`** — both are corrected below.

---

## ✅ DONE (committed + verified live)
- **Commit 1 — wedge instrumentation** (0b68271): sync stderr signal/exit handlers + 5s vitals + request lifecycle. SIGTERM→beforeExit→exit sequence **captured live**. Closed.
- **Commit 2 — cross-site logout fix** (the #2 pain): shared single-flight refresh across bootstrap + interceptor (ccd3983, `refresh-lock.ts`) + `index.html` no-cache. **Runtime-proven via Chrome** — shared refresh works and `SameSite=None; Secure` cookie accepted cross-site. *Remaining:* Danielle + Tzlil confirm in a real multi-user session (no first-click failures, F5 keeps session).
- **Commit 2 — data-integrity scan** built + run on P20 ("מבנה 1660"), P26 ("באר יעקב"), P18 baseline. **All clean:** zero orphan FKs, zero null names, no duplicate deliverables; scan ~20ms.
- **Run-now items 2 & 3** (commit 3322bca, 2026-09-22): TEMP integrity endpoint removed; load-path query-timeout guard added (`query-timeout.ts` on `planning.service.ts`). Gate #6a closed (no data to fix). *Remaining run-now:* #4 customer-block click-test, #5 wedge-watch.

## 🔎 CORRECTED FINDINGS (important)
1. **Category disconnect — real root cause (corrects earlier "same table"):** the New-Project *Project Category* dropdown reads `/admin/config/project-types` → **`ProjectType`** table. The Templates→Types tab **labelled "Project Categories"** is internally key `'service'` → `/service-types` → **`ServiceType`** table — a *different* table. So categories added in that tab land in `service_types` and never reach the dropdown. `ProjectType` is edited on a separate admin route (`/project-types`), not in the Types tabs. → It's a **mislabelled tab pointing at the wrong table**, not a cache/seed/env issue. The Hebrew rows (מגורים/מסחר/מלונאות/חינוך/בטחוני) currently sit in `service_types`.
2. **Wedge — Failure B (data-triggered stall) DISPROVEN.** Migrated projects are structurally clean and load in ~20ms. No cleanup needed. The wedge's remaining suspects are **(a)** a slow-query-under-load event-loop stall, or **(b)** a memory/connection leak over hours, or **(c)** external/platform OOM. Next step is to catch the next natural wedge with the Commit-1 instrumentation (see run file).

## 🟡 OPEN — runnable now (no decision needed) → in `qa3-run-now.md`
- Close gate #6a (no data cleanup — nothing to fix).
- Add load-path query-timeout guard (defense-in-depth for the wedge).
- Customer-block click-test (does picking a category block the customer field?) via Chrome.
- Remove the TEMP `qa3-integrity` endpoint (it was explicitly slated for removal once the scan is done).
- Wedge-watch: keep instrumentation; on next wedge pull rss trend + Railway OOM events + signal type.

## ✅ DECISIONS — LOCKED 2026-09-22 (→ Commit 3, file `qa3-commit3.md`)
**D1 — Category model:** approved fix (A). Rewire so the "Project Categories" tab manages `ProjectType`; relabel `service_types` surface to "Services". Approved row split:
   - Categories → `project_types`: מגורים, מסחר, מלונאות, חינוך, בטחוני, Infrastructure.
   - Services → stay `service_types`: BIM management, BIM Coordination (merge the "BIM Coordination BIM" duplicate).
   - Delete: "למחוק" + the duplicate.
**D2 — Multi-select (PR-037): BUILD NOW.** Rollup rule = **primary category for rollups, extras as tags** (keep `Project.projectTypeId` as primary; junction table for the rest).

## ▶️ HOW WE PROCEED
1. **Now (no wait):** CC runs `qa3-run-now.md` — gate #6a, timeout guard, customer-block test, remove temp endpoint, wedge-watch. Danielle/Tzlil confirm the logout fix in a live session.
2. **Commit 3 (decisions locked) — `qa3-commit3.md`:** 3A rewire tabs (Project Categories→ProjectType, relabel Services) · 3B data reconciliation (gated: pause before deletes) · 3C multi-select (primary + tags). Closes PR-021/037.
3. **Then Wave 2** (cost chain → zone/service model → deliverable identity) per `qa3-master-run.md`.
4. **Wedge:** resolved opportunistically when the next event is caught + diagnosed; timeout guard is the interim protection.
5. **Go-live gate:** Waves 1–3 solid before data migration. Next review Thursday 08:30.
