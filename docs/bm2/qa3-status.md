# Planwise QA3 — Status & Line-Up (single source of truth)

**Updated:** 2026-09-22 (latest) · by analyst, verified against the repo (`staging`) and CC's live runs.

## 🚦 CURRENT STATE — Waves 1–3 CLOSED (analyst-verified)
- **Wave 1 CLOSED** (HEAD c7554c9) — instrumentation, cross-site logout fix, category-model fix + multi-select.
- **Wave 2 CLOSED** (HEAD e7bf55e) — cost surfacing (PR-035/031), zoneType-in-templates (PR-032), zone/service exposure verified, Execution dedup (PR-041).
- **Wave 3 CLOSED** (HEAD 18c2e57) — team picker + contact scoping (PR-023/026/028/038), one-table+AMC contacts, contact-add verified (PR-024), day/week/month due filter (PR-033), zone-delete guard (PR-040).
- **PR-039 RESOLVED:** Job Title = Profession, load-bearing (gates role eligibility). Decision: **keep**, add a clarifying label — no removal, no migration.

### Remaining before go-live
1. 🔴 **Logout sign-off** — Danielle + Tzlil confirm in a live multi-user session (code+Chrome verified; needs real-world OK).
2. 🟠 **Wedge root cause** — endpoint-level 10s guard in place (`fd56185`, `execution-board.service.ts`); recurrence would return 503 instead of hanging. P26 exec-board now loads 200 in 74ms server / 445ms wire (fresh container). Instrumentation still armed for the next natural event.
3. 🟠 **Design Wave** — My Tasks 6 notes (`qa3-design-wave-run.md`) + Tzlil's remaining screens as they arrive.
4. 🟠 **Wave 4** (not blocking) — Activity per-project, Drive link-only, Contacts import.
5. ⚪ Tails — id8 מלונאות (1 task), merge end-state eyeball.
6. **Go-live gate:** data migration only after the above are solid.

### 2026-09-24 — QA3 open work order · item 1 shipped
- **Item 1 · Cost-rate versioning — commit + push:** effective-dated rates on two layers (level `seniority_rates` + per-employee `user_rates`), backfilled from `default_hourly_cost` (far-past open-ended row) so existing costs are unchanged on rollout.
- **Shared cost-rate-resolver** (`apps/api/src/modules/projects/cost-rate-resolver.ts`): `user_override → level_rate_history → level_default` order. All three cost paths in `projects.service.ts` (list rollup, `computeProjectActualCost`, `getLaborCost`) rewrote through it — no more drift between the surfaces.
- **Admin endpoints:** `GET /admin/config/seniority-levels/:id/rates`, `POST /rates/change`, `GET /admin/config/user-rates/:userId`, `POST /change`, `DELETE /current` — all with the close-current + open-new semantics; forward-effective only.
- **UI:** "Change rate" row action on `seniority-levels-page` opens a history-listing modal; "Cost rate override" (💰) row action on `/admin/employees` opens the same-shape override modal (set / change / remove).
- **DoD verification (staging):** [pending post-deploy]
- **Items 2 / 3 / 4 / 6:** not started this session — will land in follow-up sessions per pace agreed with Yulian.

### 2026-09-23 — Wedge follow-up + PR-041 close
- **P26 exec-board wedge repro (`GET /execution-board?projectId=26`):** captured signal (no `req.start` in logs mid-request, container SIGKILL'd by killswitch after ~30s of loop unresponsiveness). Container recycled at 11:35:41; fresh boot completes the same request in 74ms server / 445ms wire.
- **Containment (`fd56185`):** `execution-board.service.ts` `getData` wrapped in `withQueryTimeout(getDataImpl, 10s, ...)`; on recurrence returns 503 instead of hanging.
- **Root cause not identified.** Direct DB timings show all 5 parallel Prisma queries < 50ms; transforms are O(n) linear. Suspects: (a) socket-write stall on a very large response body (200 KiB brotli — the `content-length` header is missing on the successful response), (b) transient Prisma prepared-statement stuck state cleared by restart, (c) upstream event-loop backpressure. Next natural wedge should hit the 10s guard and produce a clean 503 timing line + `WedgeKillswitch` skip.
- **PR-041 dedupe verified on P26:** exec-board renders 7 unique deliverable columns, zero duplicates (`בקרה ראשונה`, `התנעה`, `בקרה למכרז`, `תכנון ראשוני`, `מוכנות לביצוע`, `תכנון מפורט`, `תכנון סופי`). Already verified on P18 pre-wedge; now green on both.

---

**This doc supersedes the category section and the Failure-B section of `qa3-work-order.md`** — both are corrected below.

---

## ✅ DONE (committed + verified live)
- **Commit 1 — wedge instrumentation** (0b68271): sync stderr signal/exit handlers + 5s vitals + request lifecycle. SIGTERM→beforeExit→exit sequence **captured live**. Closed.
- **Commit 2 — cross-site logout fix** (the #2 pain): shared single-flight refresh across bootstrap + interceptor (ccd3983, `refresh-lock.ts`) + `index.html` no-cache. **Runtime-proven via Chrome** — shared refresh works and `SameSite=None; Secure` cookie accepted cross-site. *Remaining:* Danielle + Tzlil confirm in a real multi-user session (no first-click failures, F5 keeps session).
- **Commit 2 — data-integrity scan** built + run on P20 ("מבנה 1660"), P26 ("באר יעקב"), P18 baseline. **All clean:** zero orphan FKs, zero null names, no duplicate deliverables; scan ~20ms.
- **Run-now items 2 & 3** (commit 3322bca, 2026-09-22): TEMP integrity endpoint removed; load-path query-timeout guard added (`query-timeout.ts` on `planning.service.ts`). Gate #6a closed (no data to fix). *Remaining run-now:* #4 customer-block click-test, #5 wedge-watch.
- **Commit 3 — Category model fix — CODE-VERIFIED by analyst (HEAD e28cc23):** 3A (162b6f6) "Project Categories" tab now wired to `ProjectType` (`/admin/config/project-types`), old tab relabelled "Services"; 3B (9b20db8) reconciliation applied via temp endpoint; 3C-a (cb9cde3) `ProjectCategoryLink` junction + `projectTypeId` kept PRIMARY; 3C-b (e28cc23) chip multi-select UI, **live DoD 5/5 via Chrome**. Matches the corrected spec + locked decisions.

## 🧹 WAVE-1 CLOSE CHECKLIST (remaining)
- [ ] **Cleanup commit:** remove the two temp controllers still in code — `Qa3ReconciliationController` (9b20db8) + `Qa3ThreeCBackfillController` (7a659f2) + `admin.module.ts` entries. Confirm routes 404.
- [ ] **service_types tail:** id 14 "BIM Coordination BIM" → merge into id 13; id 8 "מלונאות" (1 task) → keep + flagged (Yulian to pick its real service later).
- [ ] run-now **#4** customer-block click-test (yes/no + screenshot) · **#5** wedge-watch armed.
- [ ] **Danielle + Tzlil** confirm the logout fix in a live multi-user session.

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
