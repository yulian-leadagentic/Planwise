# QA3 · Blocker — task creation 400 (mislabeled "TASK-ADD-500")

> Real error captured on staging: `POST /api/v1/tasks` returns **400 Bad Request** (the frontend
> mislabels the toast `TASK-ADD-500`). It is the core-fields guardrail, not a crash.
> Decision (Yulian, 2026-08-31): **Option B — relax the guardrail.** A task is creatable with a
> **Zone only**; Service & Deliverable are **optional at creation and at update**; they are filled in
> later inline in the grid. `requiresReview` gets a server-side default.

## Root cause (traced)
`tasks.service#create` runs `missingCoreFields(dto)` (`:136-143`) which requires **Service + Zone +
Deliverable + explicit Review** and throws `BadRequestException` (400) when any is absent. But the UI
adds tasks without those fields:
- **Inline "Create New Task" (empty row)** — `planning-modal.tsx ~3392 / ~3743` sends only
  `zoneId + code + name + budgetHours + budgetAmount` (no service/deliverable/requiresReview).
- **Catalog / Template add** — `buildTaskAddPayload` (`:1386`) fills `serviceTypeId`+`zoneId` from
  context and defaults `requiresReview:true`, but **Deliverable comes only from the group context**;
  adding under a **Zone** group (no deliverable) leaves `projectDeliverableId`/`deliverableTemplateId`
  undefined → 400. (`CatalogPickerForZone.handleAdd :1455`; the `TASK-ADD-500` toast is `:1462`.)

## Fix — backend (`tasks.service.ts`)
1. **Relax `missingCoreFields`**: for a non-personal task the only hard requirement is a **Zone**
   (or a `projectId` for project-root tasks so placement is known). **Drop `serviceTypeId`,
   deliverable, and `requiresReview` from the "missing/required" set** — they become optional.
2. Keep `requiresReview` defaulting to `true` in the `create` data (already `?? true`) — server-side
   default, never user-blocking.
3. Apply the same relaxation on **update** — never reject a partial edit for missing service/
   deliverable (so inline-setting them later, one at a time, never 400s). Keep the "only run when the
   update actually touches a core field" behavior from PR-010/011.
4. Leave personal-task and zone→projectId resolution exactly as-is.

## Fix — frontend
5. **Stop mislabeling the error.** Replace the generic `notify.error('Failed to add tasks',{code:'TASK-ADD-500'})`
   path so validation failures surface the **real server message / missing fields** via
   `notify.apiError(err, …)`. A 400 must read as what it is, not a 500.
6. With the guardrail relaxed, the inline empty-row add and catalog/template add now succeed as-is —
   confirm both. `buildTaskAddPayload` can keep sending whatever context it has.
7. **PR-019 other half — fix the Deliverable inline picker.** After creating a bare task, setting its
   Deliverable inline in the grid must offer the **correct set** — deliverables of the task's Service
   (or the project's deliverables when no service yet), not a wrong/reduced list. This is what lets
   "add empty row now, link later" actually work.

## Downstream to verify (don't skip — real runtime check)
- A task with **no Service/Deliverable** must render in the planning grid (under a "No service /
  No deliverable" bucket) and roll up without error (rollup is already status-aware).
- Grouping by Service/Deliverable must tolerate null (a "None" bucket), not crash.

## DoD (verify on staging AFTER deploy — not build-green)
- Add an **empty row** under a Zone → **saves** (no 400).
- Add from **Catalog/Template** under a Zone → **saves**.
- Then set Service + Deliverable **inline** on that task → persists; the Deliverable picker shows the
  right set.
- Any future validation error shows the real reason, never a bare "TASK-ADD-500".

Frozen: SSO, Delivery-Planning PERT, people-filter, 3-level grouping. Verify:
`pnpm --filter api build && pnpm --filter web typecheck && build && lint`.
