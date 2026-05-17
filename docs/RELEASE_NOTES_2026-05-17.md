# Planwise — Release Notes
**Release:** May 17, 2026
**Scope:** Business Partners restructure · Project Team · Employees · Admin catalogs · Execution Board · Time tracking

---

## Executive Summary

This release reshapes how Planwise models **people and the organizations
they belong to**, and how those people are placed on projects. The
underlying goal: replace a confusing multi-role chip system with one
clear, consistent model — and give the admin team proper tools to
configure it.

Highlights:

- **Main Role** replaces multi-role chips on every contact. One value
  per person or organization, easy to scan, easy to filter.
- **Relationship Types** are redesigned with named sides (Side A →
  Side B), so every link reads like a sentence: *"Sarah Smith is
  Employee of Customer A"*.
- **Project Team** tab is rebuilt around role types — BIM Leader,
  Architect, Project Manager, etc. — each with its own section,
  picker, and rules.
- **External Employees** tab (renamed from Partners) now has a proper
  Employer Organization picker — pick which customer/supplier each
  external employee works at, and the relationship is wired
  automatically.
- **Number Ranges + Object Numbering** — a new admin capability that
  lets you control how Employee codes, Project codes, etc. are
  generated (auto / manual / external).
- **Job Titles** catalog (renamed from Profession), with optional
  per-person linkage and per-project-role constraints.
- **Seniority Levels** now carry a default hourly cost (multi-currency).
- **Execution Board** finally shows tasks added directly to a project
  (no zone) in their correct phase column, with a dedicated
  *Project Root* row.

Plus dozens of usability fixes across drawers, modals, pickers, and
the operations dashboard.

---

## 1. Business Partners — restructured around Main Role

### What changed

- **The "Roles" tab is gone from the Partner Drawer.** It's replaced
  with a single **Main Role** field shown in the drawer header.
- **One role per contact.** A person is *one* of: Customer, Supplier,
  Consultant, Subcontractor, External Contact, etc. — not a stack
  of chips that overlap and conflict.
- **Soft prompt** when the Main Role is missing: any drawer with an
  empty Main Role shows an amber strip with a one-click dropdown.
  The data isn't blocked — but it's obvious what to fill in.
- **Per-kind options.** A person sees roles that apply to people
  (Customer Contact, Consultant…). An organization sees roles that
  apply to organizations (Customer, Supplier…). The *Employee* role
  is removed from this dropdown entirely — employees are created via
  the Employees admin instead, which prevents half-set-up records.

### Where to see it

- **Partner Drawer** (open any contact) — header strip
- **Partners list** — new "Main Role" column with a colored badge
- **Create Contact / Organization / Partner** modals — single Main
  Role dropdown replacing the old multi-chip picker

### Data migration

For every existing partner who had multiple role chips, Planwise
automatically picked the **first-assigned role** as their Main Role.
Partners who never had a chip are left blank — the drawer will show
the soft prompt the next time they're opened.

The legacy chip table is preserved in read-only form for now (full
removal will happen in a later cleanup release).

---

## 2. Relationship Types — named sides + structured eligibility

### What changed

Relationship types used to be one-shot strings ("relationship of
type X targets Y"). They now have a richer, more readable structure:

- **Named Sides** — every relationship type names what each side IS:
  *"Side A: Employee"* → *"Side B: Employer"*. The drawer renders the
  full sentence both forward and backward (*"Employs of"* on the
  reverse direction).
- **Structured eligibility** — each side declares what kinds of
  partners can sit on it (Person / Organization / Project / Any),
  optionally restricted to specific Main Roles or Role Categories.
  Picking an incompatible partner is blocked at form-time with a
  clear error.
- **Categories** for grouping roles (Customer-side, Supplier-side,
  Internal, External) with chosen colors — used for filtering and
  visual scanning.

### Bidirectional display

Open any organization's drawer → the **Relationships** tab now shows
not just outgoing links (*"Contact of: Sarah Smith"*) but also
**incoming** ones (*"Has contact: Sarah Smith"*). Both directions of
every active relationship are visible from either side.

### Admin

- New **BP Types** admin tab (renamed from "Role Types") with
  separate sub-tabs for Role Types, Relationship Types, Categories.
- New three-axis side picker (kind + role codes + category codes).
- Tooltips on every type-related button for new admins.
- Legacy `customer_of_project` / `supplier_of_project` /
  `participates_in_project` relationship types are dropped — their
  function is now covered by the role-driven Project Team.

---

## 3. Project Team — role-driven layout

### What changed

The Project page **Team** tab is rebuilt around the **Project Role
Types** catalog. Instead of a flat list of people, you get one
section per role:

- **Project Manager**
- **BIM Leader**
- **Architect**
- **Customer Contact**
- … and any other Project Role Type the admin has configured

Each section has its own:

- **Picker** — only shows eligible candidates (based on Main Role
  and, optionally, required Job Title)
- **Add / Remove** controls
- **Auto-refresh** after every change (no stale list)
- **Profile link** that opens the partner drawer in place

### Project creation form

When you create a new project, the form **auto-renders required role
pickers** for every Project Role Type marked as required in the
catalog. You're prompted to assign each one before the project saves,
so projects start out fully staffed.

### Customer Contact section

The customer organization's contact list is rendered as a dedicated
section, identical to the Project Team sections — so picking
"who at the customer is our day-to-day contact for this project"
is a first-class flow.

---

## 4. Employees — renamed + employer wiring

### What changed

- The **Partners** tab on the Employees page is renamed to
  **External Employees**.
- The "Add Partner" button is renamed to **Add External Employee**.
- The "Link to existing partner" dropdown is replaced with a proper
  **searchable picker modal** — type to filter by name, email, or
  company.

### NEW: Employer Organization picker

The biggest fix on this page: when adding an External Employee, you
now pick **which customer / supplier / subcontractor they work at**.

- A new **Employer Organization** card sits at the top of the create
  form (only on the External Employees tab — irrelevant for internal
  employees).
- The picker opens a searchable list of all organizations in the
  system, showing each org's Main Role and tax ID for quick
  identification.
- On save, an `employee_of` relationship is automatically wired
  between the new person and the chosen organization — so the
  context is set up correctly with no extra clicks.

### New employment fields

The People page (both tabs) now captures:

- **Code** — Employee number, allocated from the Number Range admin
  (auto / manual / external — see §6)
- **Job Title** (renamed from Profession) — picks from a catalog
- **Authorization Role** (renamed from Role) — controls app
  permissions
- **Department**
- **Telephone**
- **Start Date**
- **End Date**
- **Daily Standard Hours**
- **Seniority Level** — with inline preview of the default hourly
  cost

---

## 5. Job Titles (renamed from Profession)

### What changed

- The "Profession" concept across the app is renamed to **Job Title**
  — including the admin catalog, the partner drawer section, and
  the people-page column.
- Partners can be linked to multiple Job Titles, with one marked
  **Primary** (e.g. "Architect" + "BIM Manager", primary = Architect).
- **Project Role Types** can now optionally require a specific Job
  Title — so the Project Team picker for "BIM Leader" only suggests
  people who have "BIM Manager" or "BIM Coordinator" as a Job Title.

### Where to see it

- **Admin → Job Titles** (new tab)
- **Partner Drawer → Details** — Job Titles section
- **Employee form** — Job Title dropdown

---

## 6. Number Ranges + Object Numbering — new admin capability

### What's new

Two completely new admin pages give you full control over how object
codes (Employee numbers, Project numbers, etc.) are generated.

### Admin → Number Ranges

A reusable **sequence library**. Each range has:

- A short **code** (e.g. `EMP-MAIN`, `PROJ-2026`)
- A **prefix** (e.g. `EMP-`)
- A **width** (e.g. `4` → `EMP-0001`)
- A **mode**:
  - **auto** — the system allocates the next number on save
  - **manual** — the user types it (the range still validates the
    format)
  - **external** — the user types a code that matches a pattern
    (e.g. for codes coming from another system)

### Admin → Object Numbering

A page that **binds Number Ranges to specific object types**. Today
the binding is exposed for:

- **EMPLOYEE** — wires the Employee Code field on the People page
- Future: PROJECT, CONTRACT, etc.

### Live preview

Both pages show the **next code that would be issued** so you can
see at a glance what the next employee will be numbered.

---

## 7. Seniority Levels — multi-currency hourly cost

### What changed

The Seniority Levels admin page (existing) now also captures:

- **Default Hourly Cost** per level
- **Currency** dropdown (ILS, USD, EUR)
- A new admin currency catalog page

### Where it shows up

- Employee form — picking a Seniority Level shows the preview cost
- Foundation for the upcoming Employee Cost matrix feature

---

## 8. Execution Board — Project Root + phase column

### Bug fixes

Two long-standing issues with the Execution Board are fixed:

**Issue 1 — Tasks added directly to a project (no zone) weren't visible.**
When you add a task at the project level (without picking a zone),
the board now injects a dedicated **Project Root** row at the top of
each project, with the task counts and cards rendered just like any
other zone.

**Issue 2 — Tasks in the wrong column.** Root tasks were silently
dumped into the "No Deliverable" column even when they had a phase
set. They now correctly land in the phase column they were created
under (e.g. "BIM Coordination").

### Visual improvements

- Auto-scroll into view when expanding a row near the bottom of the
  viewport — no more "did anything happen?" guesswork
- "Project Root" label is now consistent across the Task Drawer,
  Operations Dashboard, My Tasks (kanban + list), Add Timesheet
  Entry, and Log Time dialog — so root tasks are no longer silently
  anonymous anywhere

---

## 9. Bug fixes & polish

| Area | Fix |
|------|-----|
| Clock Dashboard | Page crashed with "Cannot read properties of undefined". New `team-today` endpoint + defensive rendering — the page now loads even with partial data. |
| Number Ranges page | First load crashed for some admins (BigInt JSON). Fixed. |
| Number Ranges page | "New Range" wasn't saving. Fixed. |
| Project Team | Adding/removing a member didn't refresh the list. Now refreshes automatically. |
| Project Team | "Profile" link took users away from the project. Now opens the partner drawer in place. |
| Partner Drawer | The Employee role could be tagged from the drawer, leaving half-set-up records. Now hidden — employees can only be created from Employees admin. |
| Worker-of relationship | Creating "Person works at Customer A" was rejected with a misleading error about needing role "supplier". Validation now respects the rich rules defined in the Relationship Type admin. |
| Add Relationship modal | Side B picker filters by Side A compatibility, so you don't see types that can never apply. |
| Admin → BP Types | Removed "Project" from relationship-side options (project relations live on Project Team now). Added tooltips. |
| Many | Response envelope mismatch on new admin pages causing blank screens. Fixed. |

---

## How to roll out

This release is **fully backward compatible** with existing data:

1. **Database migration runs automatically** on deploy — adds new
   columns and tables, backfills `mainRoleType` from existing role
   chips (first-assigned per partner), seeds the new catalogs
   (Currencies, Seniority Levels with defaults, Partner Role
   Categories, Job Titles, Entity Kinds with their default ranges).
2. **Existing partners** with multiple role chips → their first
   chip becomes their Main Role. Drawer prompts review for any that
   were left blank.
3. **No URL changes** — existing bookmarks continue to work.
4. **No user re-onboarding required** — UI labels and flows changed
   but every existing action still has a path.

### Recommended post-deploy checklist for the admin

1. **Admin → Number Ranges** — review or rename the auto-seeded
   `EMPLOYEE` range; pick the mode (auto / manual / external) you
   want.
2. **Admin → Object Numbering** — confirm `EMPLOYEE` is bound to
   your chosen range.
3. **Admin → BP Types → Categories** — adjust the four seeded
   categories (Customer-side / Supplier-side / Internal / External)
   and their colors to taste.
4. **Admin → BP Types → Role Types** — confirm `appliesToKind` on
   each role (Person / Organization / Any).
5. **Admin → Seniority Levels** — fill in Default Hourly Cost +
   Currency on each level.
6. **Partner list** — scan for partners with "not set" Main Role
   badge; fix from the drawer.

---

## Known limitations / coming next

These items are scoped but **not** in this release:

- **Employee Cost matrix** — per-seniority, per-role hourly rates +
  project labor-cost rollup (planned next).
- **Party / Person / Organization split** — the unified
  `BusinessPartner` table will split into a Salesforce-style
  Party / Person / Organization model in a future release. The
  current data model is forward-compatible.
- **Project Addresses tab** — separate addresses per project
  (site, billing, mailing) coming in a follow-up.
- **Redesigned Partners pages** (separate Persons / Organizations
  pages with a unified create flow) — UI polish queued for after
  the cost-matrix release.

---

## Questions / feedback

Send issues to the Planwise team with as much detail as possible
(URL, expected vs. actual behavior, screenshot if possible). Each
error notification in the UI now carries a short error code
(e.g. `BP-MAINROLE-200`, `USER-CREATE-400`) — quoting it helps us
locate the relevant code path immediately.

---
*Release prepared: May 17, 2026.*
