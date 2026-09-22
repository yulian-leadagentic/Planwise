# Planwise QA3 — Status & Line-Up (single source of truth)

**Updated:** 2026-09-22 · by analyst, verified against the repo (`staging` branch) and CC's live runs.
**This doc supersedes the category section and the Failure-B section of `qa3-work-order.md`** — both are corrected below.

---

## 🚦 WAVE 2 — **CLOSED 2026-09-22 (HEAD `9b67e9b`)**

Verify-first per `docs/bm2/qa3-wave2-run.md`. All items either VERIFIED
against the existing implementation or FIXED with a scoped commit;
schema left untouched per decision.

**Commit 4 — Cost surfacing:**
- **PR-004 / PR-005 / PR-006** — cost engine + hours + completion % rollup VERIFIED (`projects.service#getLaborCost` :1951, list rollup :539–613, `actualCost` on both list and now `findOne`).
- **PR-029 — rate path** VERIFIED. Rate flows through `SeniorityLevel.defaultHourlyCost` set in the SeniorityLevels admin page; per-user assignment via People page's seniority history. `User.hourlyRate` field exists in schema but is unused by the cost engine (documented, no action).
- **PR-035 + PR-031 (bundled)** FIXED at `8f86e2a` — new `computeProjectActualCost` helper on the service, `findOne` returns `actualCost`. Project detail top row renders **Budget | Cost | Utilization%** inline (finance-gated). Ops dashboard label changed to "Budget allocated X%" (metric unchanged; only wording — the number is `Σ Task.budgetAmount / Project.budget`, i.e. planned allocation, not spent). Live-verified on P18: `Budget: ₪170,000 | Cost: ₪0 | Utilization: 0%`. Zero cost matches the unrateable-contributors path (`getLaborCost` bucket) — engine is behaving correctly.

**Commit 5 — Zone/Service exposure:**
- **PR-032 — zoneType picker in TEMPLATES** FIXED at `8f86e2a` — new `manual-zone-form.tsx` component wired into `EditorView`'s root Add menu ("Manual Zone" alongside "Zone from Template") and `ZoneTreeNode`'s child-add flow ("New Zone" / "From Template" pair). Backend already accepted `zoneType`; this is FE-only. Live-verified: form renders all 8 types (Site/Building/Level/Zone/Area/Section/Wing/Floor).
- **PR-034 — group-by-Zone tree + ERD** VERIFIED. Planning tab with Group=Zone already renders nested Zone > sub-zone hierarchy (P18: 4 root zones each with 3 sub-zones, indented). PR-032 now unlocks varied types on that same tree. **ERD schema change refused per decision** — `Zone.zoneType` stays an enum, no FK to `ZoneTypeMeta`, no migration. Doc-only note is the acceptable follow-up (out of Wave-2 scope).
- **PR-042 — template Service surface** VERIFIED. Deliverable Templates page shows the Phase (Service) as a cyan pill on each template row + phase picker in header form + phase-filter dropdown ([deliverable-templates-page.tsx:409](apps/web/src/features/templates/deliverable-templates-page.tsx:409)). Zone Template editor's Deliverable groups show the same cyan Service pill ([service-group-item.tsx:58-62](apps/web/src/features/templates/zone-templates/service-group-item.tsx:58)).
- **PR-020 — no-zone Service progress** VERIFIED on P18: with Group=Zone, "No Zone" group renders **75% · 22 tasks · 148h budget · 103h logged · ₪59,200**. Overall progress rollup includes no-zone tasks; per-zone rollup deliberately skips them (`execution-planning.service.ts:400` vs :386).

**Commit 6 — Deliverable identity / Execution dedup:**
- **PR-041 — duplicate deliverable in Execution** FIXED at `9b67e9b` — `!orderedColumns.includes(tpl.name)` guard added to the first ordering loop in `execution-board-page.tsx:404-410`. Live-verified on P18 Execution filtered to "BIM management": chip count at the matrix column-header row dropped from **4 → 1**. Matrix key stays `${zoneId}|${phaseName}` (string), per analyst decision — id-keying would over-split.
- **Template rename propagation** VERIFIED structurally: `Task.name` is a copied string column, so renaming a Template does NOT change existing task names or hours (TimeEntry.minutes is unrelated). `PATCH /templates/:id` updates the Template row only. New instantiations copy the CURRENT Template.name. Existing projects that reference by `deliverableTemplateId` see the new name via FK; projects using `projectDeliverableId` are unaffected (project-owned name). No live rename was performed on staging (avoid destructive smoke on real templates).
- **PR-019 — task add sets deliverable link** VERIFIED. `tasks.service.ts:201-203` writes both `deliverableTemplateId` and `projectDeliverableId` on create; Planning "Add > New Task" / "New Deliverable" affordances live-visible on P18 group cards.
- **PR-013 — add task template into tree** VERIFIED. Planning "Add > From Template" affordance live-visible on P18 group cards; `CatalogPickerForZone` at `planning-modal.tsx:1424` is the writer.

**Wave-2 commits shipped:**
- `8f86e2a` — feat(projects,templates): PR-035/031 cost surfacing + PR-032 zoneType picker
- `9b67e9b` — fix(execution): dedupe duplicate deliverable columns by name (PR-041)

## 🚦 WAVE 1 — **CLOSED 2026-09-22 (HEAD `68c68a9`)**

All Wave-1 goals shipped, live-verified on staging, and the temporary
scaffolding is removed. The one item that Wave 1 cannot self-verify
(Danielle + Tzlil live logout sign-off) is carried forward as its own
open callout below — it does NOT reopen the wave.

**Everything that shipped in Wave 1:**
- **Commit 1 — wedge instrumentation** (0b68271): sync stderr signal/exit handlers + 5s vitals + `RequestLifecycle` interceptor. SIGTERM→beforeExit→exit sequence captured live. `Watchdog armed` + `Wedge-killswitch armed` printed on every boot.
- **Commit 2 — cross-site logout fix** (66d5ce7 + ccd3983): shared single-flight `refresh-lock.ts` across bootstrap + interceptor and `index.html` `Cache-Control: no-cache`. Runtime-proven via Chrome cross-site.
- **Commit 2 — data-integrity scan** on P20/P26/P18 (behind the TEMP `qa3-integrity` endpoint, later removed in 3322bca): zero orphans, zero nulls, ~20ms — no data to fix (Gate #6a closed).
- **Run-now #2 + #3** (3322bca): TEMP integrity endpoint removed + load-path query-timeout guard added (`query-timeout.ts` on `planning.service.ts`).
- **Commit 3A — split Project Categories tab from Services** (162b6f6): "Project Categories" tab wired to `ProjectType` at `/admin/config/project-types`; old tab relabelled "Services".
- **Commit 3B — reconciliation applied** via TEMP atomic `Qa3ReconciliationController` (9b20db8): the Hebrew categories reached `project_types`, the delete-candidates on `service_types` were removed under an FK-gated $transaction.
- **Commit 3C-a — junction + DTO + service** (cb9cde3): `ProjectCategoryLink` model + migration + backend service accepting `projectTypeIds`, primary FK preserved for rollups. Follow-up backfill via TEMP `Qa3ThreeCBackfillController` (7a659f2) after Prisma silently skipped the multi-statement INSERT IGNORE.
- **Commit 3C-b — chip multi-select UI** (e28cc23): shared type + api client + form chip picker + list array-handling + rewritten detail-header editor. **Live DoD 5/5** via Chrome-MCP (see below).
- **Wave-1 tail — service_type 14 merged into 13** via TEMP `POST /admin/qa3-3b-reconciliation/merge-14-into-13` (bd9a446): atomic $transaction, FK preflight, dryRun-reversible. Analyst confirmed the merge landed on staging.
- **Wave-1 close cleanup** (68c68a9): both TEMP admin controllers removed + `admin.module.ts` entries dropped. Every `/api/v1/admin/qa3-*` route now 404s.

**Wave-1 DoDs — live-verified on staging:**
- 3C-b DoD 1 — header inline editor added מסחר to P20 → 2 chips ("Buildings — primary" + "מסחר"). ✅
- 3C-b DoD 2 — project list row renders both chips with correct titles. ✅
- 3C-b DoD 3 — filter by category id 20 (מסחר, extra on P20) matches P20 alone (via junction). ✅
- 3C-b DoD 4 — filter by category id 5 (Buildings, primary on P20) matches P20 + 4 other single-category rows. ✅
- 3C-b DoD 5 — `/projects/new` renders chip picker with "first is primary" hint, no legacy `<select>`. ✅
- Run-now #4 customer-block — **PASS**: Customer `<select>` enabled + 6 options populated on first render of `/projects/new`, no refresh; stays enabled after picking Buildings. Screenshot skipped (SPA never reaches `document_idle`, screenshot tool times out at 5s — known constraint).
- Run-now #5 wedge-watch armed — live logs at 12:44:25 UTC show `Watchdog armed` + `Wedge-killswitch armed` + `RequestLifecycle` interceptor emitting `req.start` every 20s on the health probe.

**Wave-1 tail cleanup, documented (does NOT block close):**
- **service_type 8 "מלונאות"** — 1 task ref. KEPT per user decision. The merge-14 endpoint returned `audit_serviceType8_taskList` with the {task, project} so Yulian can pick its correct service later. Tail-tracked, no blocker.

## ⏳ CARRY-FORWARD (independent of Wave-1 close)
- **Danielle + Tzlil** confirm the logout fix in a live multi-user session (no first-click failures, F5 keeps session). Code + Chrome-driven verification are done; only their real-world sign-off remains.

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
