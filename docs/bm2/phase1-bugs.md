# BM 2 — Phase 1: Bug pack (spec for CC)

> Source: BM 2 meetings (Aug 10 + 12), user-reported behavior on **staging**.
> Scope: this file only. Branch: `fix/bm2-bug-pack`. One commit per item. Follow
> `docs/PLANWISE_DESIGN_SYSTEM.md` for any UI. Confirm each handler in code before
> editing — the notes below are observed behavior, not exact line numbers.

## Guardrails
- Items **6** and **8** are **INVESTIGATE-ONLY** — a teammate has local WIP on permissions.
  Find and report the root cause; do **not** rewrite permissions/session logic without a go-ahead.
- Do **not** touch the frozen items (Active-project / at-risk thresholds; PERT scheduling).
- After each item run: `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web lint`
  and `pnpm --filter api build` (+ `prisma generate` on any schema change).

---

## 1 · Delivery Planning is EMPTY on a brand-new project 🐞
`apps/web/src/features/projects/deliverable-planning-tab.tsx` builds its (zone × deliverable)
rows from planning-data **tasks**, so a new project that has zones + deliverables but **no tasks
yet** renders "nothing". **Fix:** source the rows from the project's **deliverables (+ zones)**
directly (e.g. `/project-deliverables` + the project's zones) so every zone × deliverable appears
even with zero tasks. Tasks still fill the counts / bars when present.
**DoD:** create a new project with zones + deliverables and no tasks → Delivery Planning shows all rows.

## 2 · Planning: clicking a task opens the DISCUSSION bar, not the task 🐞
`apps/web/src/features/projects/planning-modal.tsx` — a task/row click currently opens the
discussion side-panel. It must open the canonical **task drawer** (`?task=N`), especially in
grouping mode where there is no other edit entry point.
**DoD:** clicking a task row opens the task drawer.

## 3 · Planning: "Collapse all" button disappeared 🐞
Restore the collapse/expand-all control on the Planning grid (`planning-modal.tsx`) — it existed
before and was lost.
**DoD:** a working Collapse-all / Expand-all control is back.

## 4 · Planning: "Add" missing when sub-grouping + wrong field in dialog 🐞
(a) The "+/Add task" button appears only at the **zone** level when sub-grouping — show it in
**every** group. (b) When grouped by **Deliverable**, the new-task dialog still offers "Services"
instead of prefilling the **Deliverable** — carry the grouping context into the dialog. Keep the
existing **core-vs-personal** choice on add (core requires Service/Zone/Review/Deliverable; personal
does not).
**DoD:** Add is available in every group; the dialog prefills the correct Deliverable when grouped by Deliverable.

## 5 · Executive Review: Due date not shown / not editable 🐞
`apps/web/src/features/dashboard/parts/executive-review-tab.tsx` — show the task **Due date**
column and make it **editable inline** (persist via the task update endpoint), alongside the other
inline edits.
**DoD:** Due date shows and can be edited inline in the Executive Review tab.

## 6 · INVESTIGATE-ONLY — permissions: some users invisible 🔎
Some users are invisible (e.g. Amit Maimoni, Daniel Malka) even to an admin; "I don't see myself."
**Find the root cause and report it** (file:line + why). Do **not** rewrite permissions logic — a
teammate has a local pass in progress.

## 7 · Team: adding a person to a project doesn't show up 🐞
Adding an internal person to a project (the "Projects" access list / cards) does not appear in the
list. Trace the add mutation + list refresh (project team / `project-partner-roles`) and fix so the
added person shows **immediately** (invalidate the right query; confirm the person is persisted with
project access).
**DoD:** adding a person to a project shows immediately without a manual refresh.

## 8 · INVESTIGATE-ONLY — app throws the user out mid-work 🔎
The app logs the user out during work (session / refresh / token). **Diagnose and report**; apply
only a clearly-safe small fix, otherwise leave it for the owner.

---

## Definition of done (phase)
All verify commands green after each item. Report per-item what changed (and flag any item that
turned out to already work). Leave merge/push to the user; summarize the branch state at the end.
