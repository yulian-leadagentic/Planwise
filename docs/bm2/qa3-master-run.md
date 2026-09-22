> ⚠️ **SUPERSEDED (2026-09-22):** The **COMMIT 3** section below ("bind Category ← ProjectType") is OUT OF DATE and WRONG. Root cause was corrected — the "Project Categories" tab writes to `service_types`, not `project_types`. Follow **`qa3-commit3.md`** for Commit 3 and **`qa3-status.md`** for current state. The rest of this file (Commits 1,2,4+ and the wave split) still stands.

# Planwise QA3 — Master Development Run (single continuous sequence)

**From:** Yulian (via analyst/reviewer) · **Date:** 2026-09-17 · **For:** CC
**Run this end-to-end, commit by commit, in order.** Full per-issue detail lives in the planwise project: `claude/planwise-qa3-work-order.md` (clusters C0–C9) and `claude/planwise-auth-wedge-deep-dive.md`. This file is the ordered execution script; the work-order is the reference.

## Global run rules (apply to EVERY commit)
1. **Verify-first.** Before editing, read the actual code path and state the current behavior. No fix on assumption.
2. **Runtime DoD, not green-build.** A commit is "done" only when verified live on staging with a captured signal (HTTP status, log line, or a tester confirming). If you cannot verify it live, **stop and report** — do not mark done. (This replaces the shallow green-build DoDs that missed real failures.)
3. **Surface reservations before coding.** Flag risk; don't push through it.
4. **Design system + dark mode** on any UI change (`planwise-design` skill); must render correctly in dark mode.
5. **One concern per commit**, clear message, list files touched, deploy to staging, verify, then move on.
6. **Two hard gates — pause and get a yes before running:**
   - Any **data-mutating cleanup** (Commit 2): take a DB **backup first**, make the migration **idempotent + reversible**, run on **staging only**, and post the row-counts you'll change before applying. **Never touch production data** in this run.
   - **Service-worker removal / cache-header change** (Commit 2): it invalidates every loaded client once — describe the one-time effect, then proceed on staging.
7. **Locked product decisions** (do not re-litigate): Job Title = **closed list only, no free-text**. Project Team/Contacts = **one table + include/exclude-AMC filter** (not two tables).
8. Do **not** use project **1660** (or Baer Yarkon) as a test fixture for cost/anything until Commit 2 clears them.

---

## COMMIT 1 — Wedge instrumentation (no behavior change)
Ship first so the next wedge leaves a trace.
- Sync handlers via `process.stderr.write` (bypass pino): `SIGTERM`, `SIGINT` → `"received signal X @<ISO>"`; `process.on('exit', code=>…)`; `beforeExit`.
- Vitals cadence 30s → 5s.
- Request-scoped log at start+end: `reqId`, method, path, `projectId?`, duration-ms.
- Confirm stderr writes are unconditional and visible in Railway logs.
**DoD:** deployed to staging; a forced test request shows the start/end lines; handlers confirmed wired.

## COMMIT 2 — Auth / logout / project-load wedge (investigate → fix)
Follow `planwise-auth-wedge-deep-dive.md`. Investigate both hypotheses, then implement only what the evidence confirms; write findings into the deep-dive doc as you go.

**B1 — data-triggered stall (likely mass-outage cause):**
- From Commit-1 logs, find the request in-flight at each SIGKILL.
- Server-side timing (Railway shell, not the app): `curl -w '%{http_code} %{time_total}\n'` load endpoints for 1660 + Baer Yarkon vs Carmei Modiin.
- Read-only integrity scan (1660 first, then all migrated projects): orphaned FKs (task→deliverable, deliverable→zone, deliverable→service, zone→project, assignment→person), unexpected NULLs on the load path, duplicate/instance rows; diff vs a clean new project.
- **Fix (gate #6a):** reversible+idempotent cleanup migration for the orphans (backup first, staging only, post counts) **and** harden the load path so one bad project can't stall the loop — bounded includes + a query timeout that returns a clean error instead of hanging.

**B2 — auth refresh race / stale bundle:**
- Fix the axios interceptor to **single-flight** refresh and **replay** the queued original requests (kills the "second click works" symptom).
- Guarantee an `await refresh()` on bootstrap **before** the first authed call.
- **Stale bundle/SW (gate #6b):** if a service worker is registered or `index.html` is cacheable, set `Cache-Control: no-cache` on `index.html`, cache-bust the bundle, and unregister the SW if unused (explains `F5` bad / `Shift+F5` good).
- Confirm the cross-site cookie fix is live: `Set-Cookie … SameSite=None; Secure` on `/auth/login` and `/auth/refresh` in the network tab.

**DoD (live, with Danielle + Tzlil):** 1660 + Baer Yarkon load < 2s / HTTP 200; integrity scan returns zero orphans; token-expiry → action succeeds on the **first** click; plain `F5` keeps the session; checklist **item 32 (refresh-logout)** and **item 29 (SSO — capture Entra vs Google first)** pass; 30-min multi-user session with zero unexpected logouts.

## COMMIT 3 — Project Category binding + customer-block (PR-021, 037, 025, 022)
Verify the dropdown currently reads a hardcoded enum, not the `projectCategory` table.
- Bind New-Project Category dropdown to the **custom Project Categories** table; store **by FK id**; **multi-select**.
- Fix the dependent "project rule types" fetch: empty → empty state, **never blocks the customer field/form**.
- Remove the "add organization" option from New Project (PR-025; orgs live only in Partners).
- Customer/client wording points at the right entity; list content is Amit's — don't invent it.
**DoD:** add a category in Types → appears in New Project; multi-select persists; selecting a category never breaks the customer picker (first-try, no refresh); no org-add in New Project. Tester-confirmed.

## COMMIT 4 — Cost / hours / budget chain (PR-029 → 004 → 031 → 035; verify 005, 006)
Fix in dependency order.
- **PR-029:** enable setting employee **hourly rate** (Templates → Employees); confirm storage + that the cost calc can read it.
- **PR-004:** reporting hours in Time rolls **cost** up task→deliverable→zone→project; expose a Cost value.
- **PR-031:** each project card shows **budget utilization (Cost)** next to total budget.
- **PR-035:** project total cost in the **top row**.
- Verify PR-005 (hours rollup) and PR-006 (completion %) still correct.
**DoD:** set rate → report hours → cost = hours×rate at every rollup level; budget-vs-cost on card + top row. Live (use a clean project, not 1660).

## COMMIT 5 — Zone / Service model + templates (PR-032, 034, 042, 020)
Biggest structural unit; verify-first the current schema. Sub-steps in one logical commit (or split 5a/5b if cleaner):
- **Schema/ERD:** add `zoneTypeId` FK on Zone; expose in the ERD generator.
- **PR-032:** add **zone-type tagging inside Zone templates** (reuse the picker that already exists in manual task creation).
- **PR-034:** enable **tree decomposition** in group-by-Zone; grouping shows **Zone > Building > Level** (Yulian's priority).
- **PR-042:** make the **Service association reachable through templates** — deliverables know their Service; surface it so a systems-coordination template reads as that Service; the Zone label shows its service context.
- **PR-020:** the **no-zone (model-management) Service rolls up progress** from completed deliverable tasks.
- Terminology: keep the type **label configurable/renamable** (the deeper "Zone" rename is Amit's semantic call — don't hardcode it away).
**DoD:** template zone-type tagging works; group-by-Zone renders Zone>Building>Level; systems-coordination template reads as that Service; model-management (no-zone) shows correct progress. Live on a fresh project.

## COMMIT 6 — Deliverable identity + Execution dedup (PR-041; template refresh; verify 019, 013)
- Deliverable identity = **id, never name**. Rename/recompose keeps the link; grouping/dedup keys on `deliverableId` (fixes PR-041 duplicate rows in Execution).
- New projects instantiate from the **current** template; template edits do **not** rewrite existing projects; reported hours never lost.
- Verify PR-019 (tasks get service/deliverable link on add) and PR-013 (add task template into tree).
**DoD:** rename a template deliverable → new project shows new name + correct link; Execution shows each deliverable once; hours preserved. Live.

## COMMIT 7 — Team picker & project-contact scoping (PR-023, 026, 028, 038; checklist 4)
- **PR-023:** role person-picker **filters by role** (adding Team Leader shows only company Team Leaders).
- **PR-026 / checklist 4:** project contact list shows **only project-linked contacts**; after selecting an org in team, show **only that org's** contacts.
- **PR-028:** project-table role cell offers all company people in that role; picking one not on the team **auto-adds them to the team**.
- **PR-038:** allow assigning company Project-Team people to project roles (BIM Manager, MEP Coordinator, …).
- Preserve **multi-org consultants** (a contact can serve several clients — don't collapse to one org).
**DoD:** role picker role-filtered; contacts project/org-scoped; quick-assign auto-adds; multi-org preserved. Live.

## COMMIT 8 — Contact add screen + job-title/discipline (PR-024, 039)
Locked decision applied.
- Name: **English required, Hebrew optional.**
- **Job Title: closed managed list only — NO free-text.**
- **Main Role: keep** (drives person↔project↔category filtering) — just **clarify the label** vs Job Title.
- Add **Discipline** picker from a list + a Discipline table in the customization screens.
- **PR-039:** determine what Job Title on a team member does (appears to grant role categories/permissions); pull original intent from docs — keep-and-document or remove if leftover.
**DoD:** contact-add matches the above; Discipline list selectable; Job-Title behavior documented or removed. Live.

## COMMIT 9 — Execution / planning surfaces (PR-033, 040; verify 017, 018)
- **PR-033:** Executive Review **"due this week / near due-date" filter**.
- **PR-040:** fix zone delete; **block delete when hours already reported** under the zone.
- Verify PR-017 (extra grouping level + Zone/Service/Deliverable in filter) and PR-018 (chronological ordering in Planning + Deliverable Planning, only when not manually reordered).
**DoD:** near-due filter works; zone delete works + blocked when hours exist; ordering/grouping confirmed. Live.

## COMMIT 10 — Activity Log + Drive link + Contacts import (checklist 24–27, 18–23, 10–17, 28)
- **Activity Log:** per-project logging currently only records project-creation. Log the same events as the global log (task create, status change, assignee add, etc.) with correct actor + category, per project.
- **Drive:** **pause the folder-tree automation**; implement only **linking a project to its existing Drive folder location**. (Full Drive integration needs a process with client IT.)
- **Contacts import:** fix the upload error so a real file reads without error; align "add contact to project" with Commit 7. Full import wizard can follow post-go-live.
**DoD:** per-project Activity shows create/status/assignee with actor; project↔Drive-folder link works; contacts import reads a real file without error. Live.

## COMMIT 11 — Design integration (C9)
Structural pieces CC can do now; visual polish follows Tzlil's Figma (delivered screen-by-screen).
- **Contacts layout (locked):** one table + **include/exclude-AMC filter**, core consultants sorted first, table view toggle, **"copy external contacts' emails"** button.
- **Progress reconciliation:** the two progress numbers disagreed (top 43% vs inner 51%) — reconcile to **one calculation**, keep one bar, remove the duplicate; annotate what was removed.
- **Tasks-without-due-date + "!" indicator:** do **not** hide assigned tasks lacking a due date; **shrink** the "!" / consider a right-side Notifications affordance (final placement per Tzlil's design).
**DoD:** contacts one-table + filter + copy-emails live; a single reconciled progress number; assigned no-due-date tasks visible with a compact indicator. Dark-mode checked.

---

## Closeout
After Commit 11: post a single status report — each commit's live-verification result, the two gate decisions' outcomes (data cleanup counts; SW/cache change), any items that couldn't be verified live (with why), and the remaining design screens awaited from Tzlil. Go-live gate (Yulian): create-project-and-operate must be solid **before** data migration. Next review: **Thursday 08:30**.
