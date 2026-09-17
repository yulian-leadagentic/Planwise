# Planwise — QA3 Consolidated Work Order (Project screen)

**Author:** analyst/reviewer · **For:** CC · **Date:** 2026-09-17
**Sources merged:** `QA Test Cases 3.xlsx` (sheet *ניהול בדיקות מסך Project*, PR-001→042 + *BM2-QA-Checklist* with Yulian's inline notes), the BM meeting transcript (Sep 16–17), and the two New-Project/Types screenshots.

**How to read:** issues are deduped into clusters. Each cluster gives the PR/checklist IDs it covers, priority, root-cause hypothesis, the agreed decision from the meeting, the fix, and a runtime DoD. **Verify-first on every commit; surface reservations before coding; keep design-system + dark mode intact.** Auth/wedge (C0) is specced separately in `planwise-auth-wedge-deep-dive.md` and is the top priority.

Priority key: 🔴 high · 🟠 medium · ⚪ low. Status from the sheet: אושר = resolved (verify only), ממתין = open.

---

## C0 — Auth / logout / project-load wedge 🔴
**IDs:** PR-030, checklist 29 (SSO **FAIL**) + 32 (refresh-logout **FAIL**). **See the dedicated deep-dive doc.** Do this first; the rest of QA3 can't be trusted until testers stop getting bounced.

---

## C1 — Project Category disconnect + customer-select block 🟠→🔴
**IDs:** PR-021 (open), PR-037 (open), transcript 17:29–18:45 (customer couldn't be selected until category removed + hard refresh), PR-022, PR-025.

**What's wrong (from the two screenshots):** Templates → Types → *Project Categories* holds 10 custom rows (מלונאות, מגורים, בטחוני, למחוק, חינוך, מסחר, Infrastructure[INFRA], BIM management, BIM Coordination, BIM Coordination BIM). But the **New-Project "Project Category" dropdown shows a different, hardcoded list**: BIM Coordination, BIM Management, Buildings, Infrastructure, Mixed, Roads, Software. So the field is bound to a **hardcoded enum**, not to the custom-categories table.

**Root-cause hypothesis:** the New-Project form reads a static enum/const for category options and stores a string, ignoring the `projectCategory` table. Separately, **selecting a category triggers a dependent fetch** ("no project rule types configured yet") that errors and **blocks the customer field** — which is why removing the category + `Shift+F5` let the customer be picked again (transcript 18:16–18:45). C1 and that customer-block are almost certainly the same bug surface.

**Decision / fix:**
1. Bind the dropdown to the **custom Project Categories** table (GET the categories; render name; store category **by FK id**, not string).
2. **Multi-select** (PR-037: e.g. מגורים + מסחר together).
3. Fix the dependent "project rule types" fetch so an empty result renders an empty state, **never blocks** the customer field or the form.
4. PR-025: **remove the "add organization" option** from New Project — organizations belong only in Partners.
5. PR-022: customer vs client wording — the selectable list is *customer*; **Amit owns the list content**; CC just ensures the field labels/points at the right entity.

**DoD:** categories shown in New Project == the Types table (add one in Types → it appears in New Project). Multi-select persists. Selecting any category never disables/breaks the customer picker; customer selectable on first try, no refresh needed. Verified live.

---

## C2 — Cost / hours / budget chain 🔴
**IDs:** PR-029 (open, hourly rate), PR-004 (open, cost not updating + no cost access), PR-031 (open, show Cost utilization per card), PR-035 (open, project cost in top row), PR-005 (resolved — verify), PR-006 (resolved — verify completion %).

**Root-cause chain (fix in this order):** cost = hours × employee hourly rate. **PR-029: you can't set an employee's hourly rate** → so cost can't compute → **PR-004: cost never updates from Time and there's no cost surface**. So:
1. **PR-029 first:** enable setting hourly cost per employee (Templates → Employees). Confirm where it's stored and that it's readable by the cost calc.
2. **PR-004:** when hours are reported in Time on a task, roll cost up (task → deliverable → zone → project) and expose a Cost value. Verify against a known project (1660 was the test project — but see C0/Failure B before trusting 1660).
3. **PR-031:** each project card shows **budget utilization (Cost)** alongside total budget (next to Budget Amount — transcript 7:51–8:04).
4. **PR-035:** project total cost shown in the **top row** of the project.

**DoD:** set a rate → report hours → cost appears and matches hours×rate at every rollup level; budget-vs-cost visible on the card and top row. Live.

---

## C3 — Zone / Service model + templates 🔴
**IDs:** PR-032 (open, zone-type not supported in Zone template), PR-034 (open, group-by-Zone tree decomposition + no ERD link Zone→ZoneType), PR-042 (open, no Service association via templates), PR-020 (resolved? — model-mgmt service shows no progress), transcript 8:10–39:40.

**The model, as pinned in the meeting:** two axes — **Services** (ניהול מודל / model-management, and תיאום מערכות / systems-coordination) and **Zones** (physical parts: floors/levels). Key facts:
- **Model-management is project-wide (no-zone / "zone-zero")**; systems-coordination is **per-zone (levels)**. Both are Services.
- A **Zone is just a typed row** — it can be non-physical. Manual task creation *lets you pick a Zone type* (Level, etc.), but **the Zone *template* does not let you tag the zone with a type** — that's the core gap (PR-032, transcript 35:03–36:21).
- Grouping decision (Yulian, 39:00–39:40): **Group by Zone → then show the different Zone *types* → Zone > Building > Level.** He wanted this done first ("even today").
- **Terminology:** "Zone" is confusing to the building teams (Tzlil, repeatedly). Decision: make the **type label configurable/renamable**; the deeper rename is a **semantic discussion owned by Amit** (send a mail, involve more people) — not a code blocker. Do the structural work; leave the label swap-able.

**Fix:**
1. **PR-032:** add **Zone-type tagging inside Zone templates** (same picker that already exists in manual task creation).
2. **PR-034:** add `zoneTypeId` FK on Zone and **expose it in the ERD**; enable **tree decomposition** in group-by-Zone (Zone > sub-type > level).
3. **PR-042:** make the **Service association reachable through templates** — a template's deliverables know their Service; surface/borrow that so a zone-template built of systems-coordination deliverables is clearly under the systems-coordination Service (the Zone itself needn't "know" its service, but the grouping/labels must show it — transcript 15:04–16:21).
4. **PR-020:** ensure the **no-zone (model-management) Service rolls up progress** from its deliverables' completed tasks.

**DoD:** in a template you can tag a zone's type; group-by-Zone renders Zone>Building>Level; a systems-coordination template reads as that Service; model-management (no-zone) shows correct progress. Live, on a fresh project.

---

## C4 — Deliverable identity / template refresh 🔴
**IDs:** transcript 20:03–25:50 (renaming a Deliverable broke the link), PR-041 (open, duplicate deliverable rows in Execution), PR-019 (resolved — verify), PR-013 (resolved — verify).

**Root cause:** when a Deliverable was **renamed** in the template, newly-opened projects showed the **old name / a broken link** — the zone template had **burned in a stale value** and grouping keyed on **name/string, not id**. That same name-keying is the likely cause of **PR-041** (one deliverable appears many times in Execution when filtered by BIM management).

**Fix:**
1. Deliverable identity is the **id**, never the name. Renaming/recomposing keeps the link; new projects **instantiate from the current template**; grouping/dedup keys on `deliverableId`.
2. Confirm the agreed rule (Yulian 22:00, 25:17): template edits **do not retroactively rewrite existing projects**, but a **new** project must get the **current** template.
3. Nice-to-have (⚪, agreed as future): when reopening an old project after template changes, offer **"pull updates? yes/no"** with a diff (name changed X→Y, +N tasks). Not for go-live.

**DoD:** rename a template deliverable → new project shows the new name and correct link; Execution shows each deliverable **once**; hours already reported are never lost (Yulian 26:03). Live.

---

## C5 — Team picker & project-contact scoping 🔴
**IDs:** PR-023 (open, filter team picker by role), PR-026 (open, project shows ALL org contacts), PR-028 (open, role-cell should offer all company people + auto-add to team), PR-038 (open, assign Project-Team people to project roles), checklist item 4 (open: after selecting an org in project>team, show only that org's contacts).

**Decisions:**
- **PR-023:** the person picker when adding a role must **filter by role** — adding "Team Leader" shows only company Team Leaders (Danielle Truma wrongly appeared). Yulian: "the person filter must be by role" (2:36).
- **PR-026 / checklist 4:** a project's contact list must show **only contacts actually linked to that project** (and, when an org is chosen in team, **only that org's contacts**) — not every contact of the associated org.
- **PR-028:** in the project-table role cell, offer **all company people in that role** for fast assignment; if you pick someone not yet on the project team, **auto-add them to the team**.
- **PR-038:** allow assigning the company's **Project-Team people to project roles** (BIM Manager, MEP Coordinator, …) — the team-template add-role path (transcript 1:02–1:07).

**Important nuance (checklist R5 note, Yulian):** a consultant **can belong to multiple orgs** — an independent entity serving different clients. **Keep the contact-per-client link.** Do **not** collapse to "one contact = one org."

**DoD:** role picker lists only role-matching people; project contacts are project-scoped (and org-scoped after org select); role-cell quick-assign auto-adds to team; multi-org consultants preserved. Live.

---

## C6 — Contact add screen & job-title/discipline 🟠
**IDs:** PR-024 (needs-check), PR-039 (open, job-title unclear), PR-022.

**PR-024 decisions (from the earlier session, reaffirmed):**
1. Name: **English required, Hebrew optional** (HE was a prior request; can drop only if they insist — keep optional for now).
2. **Job Title:** update the list **and allow free-text**; not mandatory to proceed. *(Note: this softens the earlier "no free-text" call — confirm with Yulian, since PR-024's own note says free-text is now wanted.)*
3. **Main Role:** **keep** — it drives the person↔project↔category filtering/linking (the same filtering C5 relies on). Just **clarify the label** so it's not confused with Job Title.
4. Add a **Discipline** picker from a list (and a Discipline table in the customization screens).

**PR-039:** clarify what **Job Title on a team member** does (it appears to grant extra role categories/permissions). Pull the original intent from the docs; if it's leftover from a superseded design, remove it. Yulian: "I'll check the docs, I don't remember" (1:08).

**DoD:** contact-add matches the above; Discipline list exists and is selectable; Job-Title behavior is either documented-and-kept or removed. Live.

---

## C7 — Execution / review / planning surfaces 🟠
**IDs:** PR-033 (open, Executive Review filter by near due-date), PR-040 (open, can't delete zone), PR-017/018 (resolved — verify ordering + extra grouping level), PR-041 (see C4).

- **PR-033:** Executive Review needs a **"due this week / near due-date" filter** so a reviewer sees the immediate horizon (transcript 42:00).
- **PR-040:** deleting a zone fails (error attached in the sheet). Fix the delete; **and enforce**: no delete if hours already reported on tasks under it (Tzlil 1:09:14, Yulian "must verify").
- **Verify resolved:** PR-017 (extra grouping level + Zone/Service/Deliverable in the filter control), PR-018 (chronological ordering in Planning + Deliverable Planning, only when the user hasn't manually reordered).

**DoD:** near-due filter works; zone delete works and is blocked when hours exist; ordering/grouping confirmed live.

---

## C8 — Activity Log, Drive, Contacts import 🟠 (largely deferred for go-live, but track)
**IDs:** checklist 24–27 (Activity), 18–23 (Drive), 10–17 + 28 (Import).

- **Activity Log:** global works (24 pass); **per-project only logs project-creation**, not task create/status/assignee (25–27 **fail**, Yulian's note). Fix per-project logging to capture the same events the global log does.
- **Google Drive:** connections/permissions **not configured** (Yulian's note on 18). **Decision: pause Drive dev**; for now just allow **linking a project to its existing Drive folder location**; the folder-tree automation needs a proper process with the client's IT.
- **Contacts import:** "**cannot import files in Contacts**" (10–17 all fail) and **upload throws an error** (28). Wizard convergence incomplete. Medium — needed for onboarding/migration but not day-one create-project flow. Also align the "add contact to project" flow (28 note) with C5.

**DoD:** per-project Activity logs create/status/assignee with correct actor; project↔Drive-folder link works; contacts import reads a real file without error (full wizard can follow).

---

## C9 — Design pass (Tzlil, parallel track) 🟠/⚪
**Source:** transcript 1:09:39–1:22:37; design-status sheet (Project, Planning, Execution, Team, Cost, etc. all "needs design").

- Tzlil sends Figma screens **one at a time as they're ready** (don't wait for the batch). Yulian: when you **drop** a component, be 100% sure and **annotate** what was removed and why (e.g., project-level progress bar removed — top progress 43% vs inner 51% disagreed; C-note: two different progress calcs → reconcile the calc, then keep one).
- **Hidden tasks-without-due-date + "!" indicator:** compromise reached — **do not hide** assigned tasks that lack a due date; **shrink** the "!" and consider moving it to a **right-side Notifications** panel. Design-first; instrument later whether users click it.
- Contacts layout (C5): Tzlil prefers two tables (internal / external); Yulian prefers **one table + include/exclude-AMC filter + table view + "copy external emails" button**. **Design decision pending** — Tzlil to mock; Yulian will accept whatever the team lands on.

**DoD:** each screen reviewed against `planwise-design` skill + dark mode; dropped components annotated; progress-calc reconciled to one number.

---

## Resolved — verify-only (don't re-spec, just confirm live)
PR-001, PR-002, PR-005, PR-006, PR-007, PR-008, PR-009, PR-010, PR-011, PR-013, PR-014, PR-015, PR-016, PR-017, PR-018, PR-019, PR-020(?), PR-030(?). Several were marked "works for me / can't reproduce" — re-confirm **after C0**, because the wedge was corrupting test runs.

## Suggested execution order
1. **C0** (auth/wedge) — unblocks everything.
2. **C1** (category + customer-block) — quick, high-visibility, blocks project creation.
3. **C2** (cost chain) — start with PR-029.
4. **C3 + C4** (zone model + deliverable identity) — the deepest structural work; Yulian wanted the group-by-Zone change first.
5. **C5 + C6** (team/contacts).
6. **C7** (execution surfaces).
7. **C8** (activity/drive/import — mostly post-go-live).
8. **C9** design — continuous, parallel.

Go-live gate (Yulian, 1:23:04): everything create-project-and-operate must be solid **before** data migration, because fixing data retroactively is far harder. Next review: **Thursday 08:30–10:00**.
