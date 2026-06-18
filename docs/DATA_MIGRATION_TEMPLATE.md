# Planwise — Customer Data Migration Template

A phased plan for bringing a new customer's data into Planwise. Phased
so the system becomes usable after Phase 1, gets richer with each later
phase, and historical data can come last without blocking go-live.

## TL;DR

| Phase | Goal | Without it… | Typical effort |
|---|---|---|---|
| **1. Foundation** | Users can log in; projects can be created | Nothing else works | ~half day |
| **2. Active projects** | Day-to-day project management goes live | New projects only — no migrated work | 1–3 days |
| **3. Operations & history** | Historical hours + assignments visible | Reports are blank for past months | 1–2 days |
| Nice-to-have | Polish: rich contact info, social, budgets, templates | UX is leaner but functional | Anytime |

---

## Phase 1 — Foundation (MUST HAVE)

System is unusable without this. One file per sheet, or one workbook
with one sheet per table.

### 1a. Users (the customer's staff who will log in)

| Column | Required? | Notes |
|---|---|---|
| `first_name` | **Required** | |
| `last_name` | **Required** | |
| `email` | **Required** | Unique login identifier |
| `phone` | Recommended | |
| `job_title` | Recommended | Must match the Job Title catalog (we provide our list; customer adds theirs). Used by role-pickers. |
| `department` | Recommended | |
| `seniority` | Optional | Junior / Mid / Senior / Lead, etc. |
| `is_active` | Optional | Default `true`; set `false` for archived staff |
| `code` | Optional | Internal employee number |

### 1b. Customers (the customer's customers — i.e., the orgs they serve)

| Column | Required? | Notes |
|---|---|---|
| `company_name` | **Required** | The only truly mandatory field |
| `tax_id` | Recommended | Strongest dedupe key (ח.פ. / ע.מ.) |
| `email` | Recommended | Office email, also dedupe |
| `phone` | Recommended | |
| `address` | Recommended | One free-text line |
| `website` | Optional | |
| `notes` | Optional | |

> System fills `partner_type = organization` and
> `main_role_type_code = customer` automatically.

### 1c. Catalogs the system needs to know about

| Catalog | Required? | Notes |
|---|---|---|
| **Phases** | Recommended | Stages of work (e.g. Pre-Design, Design, תכנון מפורט). Reuse our defaults + ADD customer's. |
| **Project Types** | Recommended | (e.g. BIM Coordination, Mixed). |
| **Services** | Recommended | Service lines the customer offers (with optional deliverable codes per service). |
| **Deliverables** | Recommended | Per-service deliverables with codes (DLV-NNN). |
| **Job Titles** | **Required** | Used by role-pickers to filter who can be assigned what role. |

A "default catalog" workbook is provided; the customer extends with
anything specific to them.

---

## Phase 2 — Active projects (BUSINESS GO-LIVE)

After Phase 1 is loaded and verified, this phase brings the actual work
into the system.

### 2a. Projects (header rows)

| Column | Required? | Notes |
|---|---|---|
| `project_name` | **Required** | |
| `project_number` | **Required** | Internal project number — must be unique |
| `customer` | **Required** | Must match a name from `Customers` (Phase 1b) |
| `project_type` | Recommended | Must match the Project Types catalog |
| `phase` | Recommended | Must match the Phases catalog |
| `status` | Recommended | `active` / `on_hold` / `completed` / `cancelled` — default `active` |
| `start_date` | Recommended | DD.MM.YYYY or ISO |
| `end_date` | Recommended | Same format |
| `contract_amount` | Recommended | Numeric; currency defaults to ILS unless specified |
| `pm` | Recommended | Must match a name from `Users` (Phase 1a) |
| `weekly_meeting_day` | Optional | E.g. "Monday at 12:00" — free text |
| `authoring_tool_version` | Optional | E.g. "R24" |
| `services_per_contract` | Optional | Free text description |
| `notes` | Optional | |

### 2b. Zone breakdown per project

Provide an XML file per project with the structure:

```xml
<Root>
  <File name="Project Name">
    <Lot id="A0001"><name>Lot A</name></Lot>
    <Building id="B0001">
      <name>Tower</name>
      <Father>Lot A</Father>
    </Building>
    <Level id="C0001">
      <name>GL</name>
      <Father>Tower</Father>
    </Level>
  </File>
</Root>
```

Or a flat table — but the XML is preferred for hierarchy. Mandatory
only for projects that have zones; small projects can use a single
`NA` bucket.

### 2c. Tasks per project (the work itself)

| Column | Required? | Notes |
|---|---|---|
| `project_number` | **Required** | Must match a project from 2a |
| `zone_id` | Recommended | Must match a zone id from the XML; `NA` if project-level |
| `task_name` | **Required** | |
| `task_code` | Recommended | Either `TSK-NNNN` from the Typical_Tasks catalog OR `QT-...` for project-specific |
| `service` | Recommended | Service line this task belongs to |
| `deliverable` | Recommended | Deliverable name OR `DLV-NNN` code |
| `budget_hours` | Recommended | Number — hours budgeted |
| `start_date` | Optional | DD.MM.YYYY |
| `end_date` | Optional | DD.MM.YYYY |
| `status` | Optional | Default `not_started` |
| `priority` | Optional | low / medium / high / critical |

---

## Phase 3 — Operations & history (LAST WAVE)

After Phase 2 the system works end-to-end. Phase 3 fills in historical
context.

### 3a. Task assignments (who works on what)

| Column | Required? | Notes |
|---|---|---|
| `project_number` | **Required** | |
| `task_code` OR `task_id` | **Required** | |
| `user_email` | **Required** | Must match a user from Phase 1a |
| `role_in_task` | Optional | E.g. "Reviewer", "Lead" |
| `status` | Optional | Status of THIS assignment |

### 3b. Historical timesheet entries

| Column | Required? | Notes |
|---|---|---|
| `user_email` | **Required** | |
| `project_number` | **Required** | |
| `task_code` | Recommended | If known; otherwise project-level entry |
| `date` | **Required** | DD.MM.YYYY |
| `start_time` | Recommended | HH:MM (24h) |
| `end_time` | Recommended | HH:MM |
| `minutes` | One of (`start+end` OR `minutes`) | Total minutes; either compute from start/end or supply directly |
| `location` | Optional | `office` / `home` |
| `is_billable` | Optional | Default `true` |
| `notes` | Optional | Free text |

### 3c. Closed / archived projects (deep history)

Same shape as Phase 2a/2c with `status = completed` or `cancelled`.
Loaded separately so they don't crowd day-to-day views.

---

## Nice-to-have (any phase, never blocking)

| Item | Where it fits | Why someone would want it |
|---|---|---|
| Rich contact info on Customers / Users (mobile, social URLs, photo) | Extends 1a / 1b | Better directory UX |
| Budget breakdown per service / phase | Extends Project header | Detailed financial reports |
| Contract documents (PDFs) | Files tab per project | Centralized contract archive |
| Standard task catalog (Typical Tasks / TSK-NNNN list) | Catalog seed | Speeds up future project creation via templates |
| Holiday calendar | Admin catalog | Working-day math, timesheet expectations |
| Org chart / reporting lines | Extends 1a | Manager dashboards, approval routing |
| Past timesheet > 12 months | Extends 3b | Long-range reports |
| Photos / project gallery | Files tab | Visual project pages |

---

## Recommended sequencing for a new customer

| Week | Deliverable from customer | Deliverable from us |
|---|---|---|
| 1 | Phase 1 files (users + customers + catalog extensions) | Validated, dry-run report, list of unmatched rows |
| 2 | Phase 2 files (projects + XML + tasks) — start with 3-5 pilot projects | Same |
| 3 | Go-live with pilot; rest of projects loaded; Phase 3a (assignments) | Loaded, smoke-tested |
| 4 | Phase 3b (timesheet) | Backfilled, reports recomputed |
| Later | Nice-to-have, as appetite allows | — |
