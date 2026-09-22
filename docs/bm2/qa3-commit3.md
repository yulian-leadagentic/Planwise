# Planwise QA3 — Commit 3: Category model fix (RUN, decisions locked)

**Date:** 2026-09-22 · branch `staging` · for CC. Context: `docs/bm2/qa3-status.md`.
**Decisions locked by Yulian:** (D1) split approved — see mapping below; (D2) build multi-select **now**; rollup = **primary category for rollups, extras as tags** (keep `Project.projectTypeId` as primary).

**Confirmed code facts (don't re-derive):**
- New-Project dropdown → `useProjectTypes()` → `/admin/config/project-types` → **`ProjectType`**.
- Templates→Types tab labelled "Project Categories" = `types-page.tsx` key `'service'` → `/service-types` → **`ServiceType`** (wrong table).
- `ProjectType` CRUD already exists: `admin/project-types-page.tsx` (route `/project-types`).

**Global rules:** verify-first; runtime DoD on staging (not green build); surface reservations; design-system + dark mode; one concern per sub-commit. **Data gate (3B):** back up first, idempotent, staging only, never prod, report counts, and check FK references before removing anything.

---

## Commit 3A — Rewire the tabs (UI only, no schema, no data)
Make the labels point at the right tables.
1. In `types-page.tsx`: **relabel** the current `'service'` tab from "Project Categories" → **"Services"** (keep it wired to `/service-types` — it genuinely manages ServiceType).
2. **Add a new "Project Categories" tab** wired to **`ProjectType`** via `/admin/config/project-types` — reuse the logic/component already in `admin/project-types-page.tsx` (create/rename/delete). Don't duplicate the abstraction; share the component or its hook.
3. Result: "Project Categories" tab now edits the SAME table the New-Project dropdown reads. Adding a category there must appear in `/projects/new` after refresh.
**DoD (live):** add a test category in the new "Project Categories" tab → it appears in the New-Project dropdown; the "Services" tab still lists/edits service_types. Tester-confirmed. Then delete the test category.

## Commit 3B — Data reconciliation (GATED — get Yulian's go before the destructive part)
Verify-first: dump current `service_types` and `project_types` rows and paste them, so we act on reality, not the Sep-17 screenshot.
Apply the approved mapping:
- **Create as Project Categories** (`project_types`, idempotent — skip if name exists): מגורים, מסחר, מלונאות, חינוך, בטחוני, Infrastructure.
- **Keep as Services** (`service_types`): BIM management, BIM Coordination. (Merge the duplicate "BIM Coordination BIM" into "BIM Coordination".)
- **Delete** (test rows): "למחוק", and the duplicate "BIM Coordination BIM".
- The 6 category rows above, once created in project_types, should be **removed from service_types** — BUT **only after** checking FK references: if any deliverable/task/service references that service_type row, do NOT delete it; report it and stop for a decision.
**Safety:** back up both tables first (SELECT dump saved). Idempotent. Staging only. Report before/after counts + any FK-referenced rows that block a delete. **Pause here for Yulian's OK before running the deletes.**
**DoD:** project_types contains the 6 categories + the English seed; service_types contains only real services; New-Project dropdown shows the full category list; no orphaned FKs introduced (re-run the integrity scan logic).

## Commit 3C — Multi-select categories (PR-037)
Schema (additive, keep primary):
- New junction table `project_category_links` (projectId, projectTypeId, composite PK, index each). **Keep `Project.projectTypeId` as the PRIMARY category.**
- Backfill: for every project, insert its current `projectTypeId` into the junction as primary.
Backend:
- create/update DTOs accept `projectTypeIds: number[]`; first (or an explicit `primaryProjectTypeId`) writes `Project.projectTypeId`; all write junction rows.
- `findAll`/filter: a project matches the category filter if **any** linked category matches (`some`).
- **Rollups/grouping by category use the PRIMARY (`projectTypeId`) only** — do not multi-count.
Frontend (design-system + dark mode):
- `project-form-page.tsx`: single select → **multi-select chips**, primary marked.
- `project-list-page.tsx`: Category column render + column filter handle arrays; the QA3-A inline CategoryCell editor → chip editor.
- `project-detail` + `projects.api.ts` types updated.
**DoD (live):** create a project with 2 categories (e.g. מגורים + מסחר) → both persist, primary shown; list filter by either matches it; a category rollup counts it once (under primary); single-category projects unchanged. Migration reversible.

---

## Report back
3A verified, 3B dumps + counts (pause for go on deletes), 3C live-verified. Then Wave 1 is complete and we move to Wave 2 (cost chain → zone/service model → deliverable identity) per `qa3-master-run.md`.
