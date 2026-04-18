# Project Screens — Complete Specification

> Three distinct modes: **Create** → **Plan** → **Monitor**
> Each has its own layout, purpose, and user actions.

---

## The Three Modes

```
CREATE               PLAN                     MONITOR
(one-time setup)     (before work begins)     (during execution)
─────────────        ─────────────────        ─────────────────
Create project       Build zone tree          Track progress
Assign leader        Apply templates          View task status
Set budget/dates     Add/remove tasks         Monitor budget
Set client/type      Assign employees         Time entries
                     Set dependencies         Cost vs budget
                     Set priorities           Milestones
                     Set schedules            Resource usage
                     ↓                        Reports
                     "Start Project"
```

**Who does what:**
| Mode | Who | When |
|------|-----|------|
| Create | Admin, Manager | When a new project is signed |
| Plan | Project Leader, Coordinator | Before work begins (5-30 min) |
| Monitor | Project Leader, all team members | During project execution |

---

## Mode 1: CREATE PROJECT

### Route: `/projects/new`

### Purpose
Quick project setup — basic info only. No zone/task planning here. That happens in Plan mode after creation.

### Screen Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back to Projects                                              │
│                                                                  │
│ ┌──────────────────────── max-w-2xl center ────────────────────┐│
│ │                                                               ││
│ │  Create New Project                                           ││
│ │                                                               ││
│ │  ── PROJECT DETAILS ──────────────────────────────────────    ││
│ │                                                               ││
│ │  Project Name *                                               ││
│ │  ┌───────────────────────────────────────────────────────┐    ││
│ │  │ Savioni Kiryat Ono                                    │    ││
│ │  └───────────────────────────────────────────────────────┘    ││
│ │                                                               ││
│ │  Project Number              Project Type *                   ││
│ │  ┌──────────────────┐        ┌──────────────────┐             ││
│ │  │ PRJ-2025-012     │        │ BIM Coordination▼│             ││
│ │  └──────────────────┘        └──────────────────┘             ││
│ │                                                               ││
│ │  Description                                                  ││
│ │  ┌───────────────────────────────────────────────────────┐    ││
│ │  │ Residential complex, 2 towers + basement              │    ││
│ │  │                                                       │    ││
│ │  └───────────────────────────────────────────────────────┘    ││
│ │                                                               ││
│ │  ── DATES & BUDGET ───────────────────────────────────────    ││
│ │                                                               ││
│ │  Start Date *              End Date                           ││
│ │  ┌──────────────────┐      ┌──────────────────┐               ││
│ │  │ 📅 Mar 15, 2025  │      │ 📅 Dec 31, 2025  │               ││
│ │  └──────────────────┘      └──────────────────┘               ││
│ │                                                               ││
│ │  Project Budget (₪)        Contract Amount (₪)               ││
│ │  ┌──────────────────┐      ┌──────────────────┐               ││
│ │  │ 250,000          │      │ 250,000          │               ││
│ │  └──────────────────┘      └──────────────────┘               ││
│ │                                                               ││
│ │  ── PROJECT LEADER ───────────────────────────────────────    ││
│ │                                                               ││
│ │  Project Leader *                                             ││
│ │  ┌───────────────────────────────────────────────────────┐    ││
│ │  │ 🔍 Search team leaders...                             │    ││
│ │  └───────────────────────────────────────────────────────┘    ││
│ │                                                               ││
│ │  Shows ONLY users with role = manager or admin                ││
│ │  (not all employees can be project leaders)                   ││
│ │                                                               ││
│ │  ┌─ Selected: ─────────────────────────────────────────┐      ││
│ │  │ 👤 AM  Amit Maimoni                                 │      ││
│ │  │        Senior Project Leader · BIM Department       │      ││
│ │  │        Currently leading: 5 active projects         │      ││
│ │  └─────────────────────────────────────────────────────┘      ││
│ │                                                               ││
│ │  ── CLIENT (optional) ────────────────────────────────────    ││
│ │                                                               ││
│ │  Client / Business Partner                                    ││
│ │  ┌───────────────────────────────────────────────────────┐    ││
│ │  │ 🔍 Search clients...                                  │    ││
│ │  └───────────────────────────────────────────────────────┘    ││
│ │                                                               ││
│ │                                                               ││
│ │                     [Cancel]  [Create & Start Planning →]     ││
│ │                                                               ││
│ └───────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Fields

| Field | Type | Required | Validation | Notes |
|-------|------|----------|------------|-------|
| Project Name | text | Yes | max 255 | |
| Project Number | text | No | max 50, unique | Auto-generated suggestion shown |
| Project Type | dropdown | Yes | from `project_types` table | |
| Description | textarea | No | max 2000 | |
| Start Date | date picker | Yes | | |
| End Date | date picker | No | must be after start | |
| Project Budget | currency input | No | ≥ 0 | ₪ prefix |
| Contract Amount | currency input | No | ≥ 0 | ₪ prefix, compared to budget later |
| Project Leader | user search/select | Yes | only users where `role` = manager or admin | Show current workload |
| Client | partner search/select | No | only users where `user_type` = partner or both | |

### Project Leader Selection

The dropdown filters users by role. NOT every user can be a project leader.

```
Search: "am"
┌───────────────────────────────────────────────────────┐
│ 👤 AM  Amit Maimoni                                    │
│        Senior PL · BIM Department · 5 active projects  │
├────────────────────────────────────────────────────────│
│ 👤 SA  Sarah Amir                                      │
│        Project Leader · MEP Department · 3 active      │
├────────────────────────────────────────────────────────│
│ 👤 DA  Dan Amster                                      │
│        Department Head · Structural · 2 active         │
└───────────────────────────────────────────────────────┘

Each option shows:
  - Avatar with initials
  - Full name
  - Position
  - Department
  - Current active project count (workload indicator)
```

### After Submit
- Creates project with `status = 'draft'`
- Redirects to `/projects/:id/plan` (planning mode)
- Project leader gets notification

---

## Mode 2: PLAN PROJECT

### Route: `/projects/:id/plan`

### Purpose
Build the complete project breakdown BEFORE work begins. This is where the Project Leader spends 5-30 minutes setting up zones, applying templates, customizing tasks, assigning employees, and setting schedules.

### Who can access
- Project Leader (assigned to this project)
- Coordinators (assigned to this project)
- Admin

### When it's available
- When project `status = 'draft'` or `status = 'active'` (planning can be refined even after start)
- Button "Start Project" changes status from `draft` → `active`

### Screen Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Projects    Savioni Kiryat Ono                                            │
│ PRJ-2025-012 · Draft · Budget: ₪250,000          [Save Draft] [Start ▶]    │
│                                                                              │
│ ┌──TOOLBAR──────────────────────────────────────────────────────────────────┐│
│ │ [+ Zone ▼]  [Apply Zone Template ▼]  │  🔍 Filter tasks...  │ [Expand]  ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│ ┌──ZONE TREE + TASKS (full width, unified view)────────────────────────────┐│
│ │                                                                           ││
│ │ ▼ 🏢 Building A (BLD-A)                    12 tasks · 180h · ₪45,000     ││
│ │ │                                                                         ││
│ │ │  ▼ 📐 Ground Level (GL)                   6 tasks · 68h · ₪17,000      ││
│ │ │  │                                                                      ││
│ │ │  │  ── BIM Coordination ──────────────────────────────────────────      ││
│ │ │  │  │ Code    │ Task              │ Hrs │ ₪ Amt  │ Assign │ Start│ Pri ││
│ │ │  │  │ BIM-CD  │ Clash Detection   │ 20  │ 5,000  │ 👤 TW  │ Mar 20│ 🔴 ││
│ │ │  │  │ BIM-MA  │ Model Audit       │  4  │ 1,000  │ 👤 ── │       │ 🟡 ││
│ │ │  │  │ OPN-C   │ Opening Coord.    │ 12  │ 3,000  │ 👤 LK │ Apr 1 │ 🟠 ││
│ │ │  │                                                                      ││
│ │ │  │  ── MEP ──────────────────────────────────────────────────────      ││
│ │ │  │  │ MEP-C   │ MEP Coordination  │ 16  │ 4,000  │ 👤 LK │ Mar 25│ 🟡 ││
│ │ │  │  │ MEP-R   │ MEP Review        │  8  │ 2,000  │ 👤 ── │       │ 🟡 ││
│ │ │  │                                                                      ││
│ │ │  │  ── (Ungrouped) ─────────────────────────────────────────────      ││
│ │ │  │  │ SRV-01  │ Site Survey       │  8  │ 2,000  │ 👤 MR │ Mar 15│ 🟢 ││
│ │ │  │                                                                      ││
│ │ │  │  [+ Add Task ▼]  [Apply Service Template ▼]                         ││
│ │ │  │                                                                      ││
│ │ │  ▶ 📐 Typical Floor (TP)                  0 tasks                       ││
│ │ │  ▶ 📐 Roof (RF)                           0 tasks                       ││
│ │ │                                                                         ││
│ │ │  [+ Add Level ▼]  [Duplicate Building ▼]                               ││
│ │                                                                           ││
│ │ ▼ 🏢 Basement (BSM)                        3 tasks · 40h · ₪10,000       ││
│ │ │  ...                                                                    ││
│ │                                                                           ││
│ │ [+ Add Zone ▼]  [Apply Zone Template ▼]                                  ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│ ┌──BUDGET SUMMARY BAR───────────────────────────────────────────────────────┐│
│ │ Tasks: ₪55,000 (22%)  │  Budget: ₪250,000  │  Remaining: ₪195,000       ││
│ │ By service: BIM ₪30K · MEP ₪15K · STR ₪8K · Other ₪2K                   ││
│ └───────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Planning Toolbar

```
┌─────────────────────────────────────────────────────────────────────┐
│ [+ Zone ▼]                │  🔍 Filter...  │  [⊟ Collapse All]    │
│   → Add zone manually     │                │  [⊞ Expand All]      │
│   → From zone template    │  Filter by:    │                       │
│   → From combined template│  Service type  │  [Save Draft]        │
│                            │  Priority      │  [Start Project ▶]   │
│                            │  Assignee      │                       │
│                            │  Has assignee? │                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Task Row in Planning Mode

Each task row is **inline-editable** during planning:

```
┌──────┬──────────────────┬─────┬────────┬────────┬────────┬──────┬──────┬───┐
│ Code │ Task Name        │ Hrs │ Amount │ Assign │ Start  │ Dep  │ Pri  │ ⋮ │
├──────┼──────────────────┼─────┼────────┼────────┼────────┼──────┼──────┼───┤
│mono  │ click to edit    │click│ click  │ user   │ date   │ link │ drop │   │
│11px  │ 14px semibold    │edit │ edit   │ search │ picker │ icon │ down │   │
│gray  │ slate-700        │right│ right  │ avatar │        │      │color │   │
│      │                  │align│ mono   │+name   │        │      │badge │   │
└──────┴──────────────────┴─────┴────────┴────────┴────────┴──────┴──────┴───┘
```

### Task Row Fields (Planning Mode)

| Column | Type | Editable | Notes |
|--------|------|----------|-------|
| Code | text (mono) | Yes | Auto-generated from service type, editable |
| Task Name | text | Yes | Click to edit inline |
| Hours | number | Yes | Click to edit, right-aligned |
| Amount (₪) | number | Yes | Click to edit, mono, right-aligned |
| Assignee | user select | Yes | Search dropdown showing only project members |
| Start Date | date picker | Yes | Calendar popover |
| Dependencies | link picker | Yes | Click → shows other tasks in this zone to select as prerequisite |
| Priority | dropdown | Yes | low/medium/high/critical with color dot |
| ⋮ Actions | menu | — | Edit details, Duplicate, Move to zone, Delete |

### Task Row Actions Menu (⋮)

```
┌────────────────────────────┐
│ 📝 Edit full details       │  → opens side panel with description, notes, attachments
│ 📋 Duplicate task          │  → copies task in same zone
│ 📦 Move to zone...        │  → select target zone
│ 🔗 Set dependencies...    │  → multi-select other tasks
│ ───────────────────────── │
│ 🗑 Delete task             │  (red)
└────────────────────────────┘
```

### Adding Tasks to a Zone

When user clicks **[+ Add Task ▼]** under a zone:

```
┌────────────────────────────────────┐
│ 📋 From task catalog               │  → opens catalog browser modal
│ 📐 From service template           │  → applies full service template
│ ✏️  Create new task                 │  → inline empty row appears
└────────────────────────────────────┘
```

**Task Catalog Browser Modal:**
```
┌─────────────────────────────────────────────────────────────────┐
│ Add Tasks from Catalog                                    [×]   │
│                                                                  │
│ 🔍 Search by code or name...                                    │
│                                                                  │
│ ┌──FILTER TABS──────────────────────────────────────────────┐   │
│ │ [All]  [BIM]  [MEP]  [Structural]  [Architecture]        │   │
│ └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│ │ ☐ │ Code     │ Name                │ Hrs │ Amount │ Type     │ │
│ │ ☑ │ BIM-CD   │ Clash Detection     │ 20  │ ₪5,000 │ BIM      │ │
│ │ ☑ │ BIM-MA   │ Model Audit         │  4  │ ₪1,000 │ BIM      │ │
│ │ ☐ │ OPN-C    │ Opening Coord.      │ 12  │ ₪3,000 │ BIM      │ │
│ │ ☐ │ MEP-C    │ MEP Coordination    │ 16  │ ₪4,000 │ MEP      │ │
│ │ ☐ │ STR-R    │ Structural Review   │  8  │ ₪2,000 │ STR      │ │
│ │   │          │                     │     │        │          │ │
│                                                                  │
│ Selected: 2 tasks · 24h · ₪6,000                                │
│                                                                  │
│                              [Cancel]  [Add 2 Tasks to Zone]    │
└─────────────────────────────────────────────────────────────────┘

MULTI-SELECT: user can check multiple tasks and add them all at once.
Service type tabs filter the catalog list.
```

**Apply Service Template:**
```
┌─────────────────────────────────────────────────────────────────┐
│ Apply Service Template                                    [×]   │
│                                                                  │
│ Tasks will be added to: Ground Level (GL)                       │
│ You can edit or remove tasks after applying.                    │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📋 BIM Coordination Standard  (BC.T.1)                     │  │
│ │    6 tasks · 68h · ₪17,000                                 │  │
│ │    ▸ Preview: Clash Detection, Model Audit, Opening...     │  │
│ ├────────────────────────────────────────────────────────────│  │
│ │ 📋 MEP Package  (MEP.T.1)                                  │  │
│ │    2 tasks · 34h · ₪8,500                                  │  │
│ │    ▸ Preview: MEP Final Design, As-Built Verification      │  │
│ ├────────────────────────────────────────────────────────────│  │
│ │ 📋 Structural Review Package  (STR.T.1)                    │  │
│ │    4 tasks · 32h · ₪8,000                                  │  │
│ │    ▸ Preview: Foundation Review, Steel Inspection...       │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Click a template to apply it                                    │
└─────────────────────────────────────────────────────────────────┘
```

### Dependencies / Prerequisites

When user clicks the dependency icon on a task row or selects "Set dependencies" from the ⋮ menu:

```
┌─────────────────────────────────────────────────────────────────┐
│ Task Dependencies                                         [×]   │
│                                                                  │
│ Task: BIM-CD "Clash Detection"                                  │
│                                                                  │
│ This task must wait for:                                        │
│                                                                  │
│ ┌──CURRENT DEPENDENCIES────────────────────────────────────┐    │
│ │ ✓ SRV-01  Site Survey         (same zone)           [×]  │    │
│ │ ✓ STR-R   Structural Review   (same zone)           [×]  │    │
│ └───────────────────────────────────────────────────────────┘    │
│                                                                  │
│ Add dependency:                                                  │
│ ┌───────────────────────────────────────────────────────────┐   │
│ │ 🔍 Search tasks in this project...                        │   │
│ └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│ │ ☐ │ MEP-C  │ MEP Coordination   │ Ground Level │             │ │
│ │ ☐ │ MEP-R  │ MEP Review         │ Ground Level │             │ │
│ │ ☐ │ BIM-CD │ Clash Detection    │ Typical Flr  │             │ │
│                                                                  │
│ Tasks from ANY zone in the project can be selected.             │
│                                                                  │
│                                    [Cancel]  [Save Dependencies] │
└─────────────────────────────────────────────────────────────────┘
```

### Duplicate Zone Flow

When user clicks **[Duplicate Building ▼]** or right-clicks a zone → Duplicate:

```
┌─────────────────────────────────────────────────────────────────┐
│ Duplicate Zone                                            [×]   │
│                                                                  │
│ Source: Building A (BLD-A)                                      │
│ Contains: 3 levels · 12 tasks · 180h · ₪45,000                 │
│                                                                  │
│ New Zone Name *                                                  │
│ ┌───────────────────────────────────────────────────────────┐   │
│ │ Building B                                                │   │
│ └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│ New Code                                                         │
│ ┌──────────────┐                                                │
│ │ BLD-B        │                                                │
│ └──────────────┘                                                │
│                                                                  │
│ What to copy:                                                    │
│ ┌───────────────────────────────────────────────────────────┐   │
│ │ ☑ All child zones (3 levels)                              │   │
│ │ ☑ All tasks (12 tasks)                                    │   │
│ │ ☑ Task budgets (hours & amounts)                          │   │
│ │ ☑ Task priorities                                         │   │
│ │ ☑ Task dependencies (re-mapped to new zone)               │   │
│ │ ☐ Task assignees (start fresh)                            │   │
│ │ ☐ Task start dates (start fresh)                          │   │
│ └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│ Preview:                                                         │
│ 🏢 Building B (BLD-B)                                           │
│   📐 Ground Level (GL) — 6 tasks                                │
│   📐 Typical Floor (TP) — 0 tasks                               │
│   📐 Roof (RF) — 0 tasks                                        │
│                                                                  │
│                              [Cancel]  [Duplicate Zone]          │
└─────────────────────────────────────────────────────────────────┘
```

### Employee Assignment

When user clicks the Assignee cell on a task row:

```
┌─────────────────────────────────────────┐
│ 🔍 Search project members...            │
│                                          │
│ PROJECT TEAM                             │
│ ┌────────────────────────────────────┐   │
│ │ 👤 TW  Tom Wilson                  │   │
│ │        Structural Eng. · 3 tasks   │   │
│ ├────────────────────────────────────│   │
│ │ 👤 LK  Lisa Kim                    │   │
│ │        MEP Coordinator · 5 tasks   │   │
│ ├────────────────────────────────────│   │
│ │ 👤 MR  Mike Ross                   │   │
│ │        Civil Engineer · 1 task     │   │
│ ├────────────────────────────────────│   │
│ │ 👤 JB  Jake Brown                  │   │
│ │        BIM Coordinator · 0 tasks   │   │
│ └────────────────────────────────────┘   │
│                                          │
│ NOT ON THIS PROJECT                      │
│ ┌────────────────────────────────────┐   │
│ │ 👤 DN  Dan Neri          [+ Add]   │   │
│ │        Architect · available       │   │
│ └────────────────────────────────────┘   │
│                                          │
│ Shows only relevant employees            │
│ [+ Add] adds them to project team first  │
└─────────────────────────────────────────┘
```

**Rules:**
- Shows project members first (already on the team)
- Shows their current task count on THIS project (workload)
- Can search all employees below — clicking [+ Add] adds them to project team AND assigns them
- Only shows employees with appropriate roles (not clients/partners)

### Start Project

When PL clicks **[Start Project ▶]**:

```
┌─────────────────────────────────────────────────────────────────┐
│ Start Project                                             [×]   │
│                                                                  │
│ Ready to start "Savioni Kiryat Ono"?                            │
│                                                                  │
│ ┌──PLANNING SUMMARY─────────────────────────────────────────┐   │
│ │                                                            │   │
│ │ ✅  5 zones created                                        │   │
│ │ ✅  18 tasks planned                                       │   │
│ │ ✅  Budget allocated: ₪55,000 / ₪250,000 (22%)            │   │
│ │ ⚠️  4 tasks have no assignee                               │   │
│ │ ⚠️  6 tasks have no start date                             │   │
│ │ ✅  Project leader assigned: Amit M.                       │   │
│ │ ✅  3 team members                                         │   │
│ │                                                            │   │
│ │ Warnings don't block starting. You can assign later.       │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│ Status will change from Draft → Active.                         │
│ Team members will be notified.                                  │
│                                                                  │
│                          [Continue Planning]  [Start Project ▶]  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Mode 3: MONITOR PROJECT

### Route: `/projects/:id`

### Purpose
Track execution progress DURING the project. This is the daily view — how tasks are progressing, budget usage, who's working on what, where are the bottlenecks.

### Who can access
- Project Leader: full view + can modify
- Team members: see their tasks, log time
- Admin/Management: full view, read-only unless admin
- Department Head: review view

### Key Difference from Plan Mode
| | Plan Mode | Monitor Mode |
|--|-----------|-------------|
| Focus | Structure setup | Progress tracking |
| Task editing | Full edit (add/remove/reorder) | Status/completion updates |
| Zone editing | Add/rename/duplicate/delete | Read-only structure |
| Assignees | Bulk assign during setup | Individual task reassignment |
| Budget | Set budgets | Compare budget vs actual |
| View type | Tree with inline editing | Tabbed dashboard |

### Screen Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ← Projects    Savioni Kiryat Ono                                            │
│ PRJ-2025-012 · Active · PL: Amit M. · Budget: ₪250,000                    │
│                                                                              │
│ ┌──STATUS CARDS────────────────────────────────────────────────────────────┐│
│ │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      ││
│ │ │ Tasks     │ │ Progress │ │ Budget   │ │ Hours    │ │ Team     │      ││
│ │ │ 18 total  │ │ 42%      │ │ ₪55K     │ │ 320h     │ │ 5        │      ││
│ │ │ 4 overdue │ │ ████░░░░ │ │ of ₪250K │ │ of 480h  │ │ members  │      ││
│ │ │ 🔴        │ │          │ │ 22% used │ │ 67%used  │ │          │      ││
│ │ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘      ││
│ └──────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│ ┌──TABS─────────────────────────────────────────────────────────────────┐   │
│ │ [WBS Overview]  [Tasks]  [Team]  [Budget & Cost]  [Milestones]       │   │
│ └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│ Content area (based on selected tab)                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tab 1: WBS Overview

The zone tree with progress indicators — READ-ONLY structure, focus on completion.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ▼ 🏢 Building A                                                        │
│ │  Progress: ████████░░ 65%  │  12/18 tasks complete  │  ₪35K / ₪45K  │
│ │                                                                       │
│ │  ▼ 📐 Ground Level                                                    │
│ │  │  Progress: ██████████ 100%  │  6/6 complete  │  ₪17K / ₪17K      │
│ │  │                                                                    │
│ │  │  ── BIM Coordination ──                                            │
│ │  │  │ BIM-CD  Clash Detection    ● Complete  100%  👤 TW  ₪5K/₪5K   │
│ │  │  │ BIM-MA  Model Audit        ● Complete  100%  👤 TW  ₪1K/₪1K   │
│ │  │  │ OPN-C   Opening Coord.     ● Complete  100%  👤 LK  ₪3K/₪3K   │
│ │  │                                                                    │
│ │  │  ── MEP ──                                                         │
│ │  │  │ MEP-C   MEP Coordination   ● Complete  100%  👤 LK  ₪4K/₪4K   │
│ │  │                                                                    │
│ │  ▼ 📐 Typical Floor                                                   │
│ │  │  Progress: ████░░░░░░ 35%  │  2/6 complete  │  ₪6K / ₪17K        │
│ │  │                                                                    │
│ │  │  │ BIM-CD  Clash Detection    ◐ In Progress  65%  👤 TW  ₪3K/₪5K │
│ │  │  │ MEP-C   MEP Coordination   ○ Not Started   0%  👤 ──  ₪0/₪4K  │
│ │                                                                       │
│ │  ▶ 📐 Roof                      0%  │  0/3 complete                   │
│                                                                          │
│ ▼ 🏢 Basement                                                           │
│ │  Progress: ██░░░░░░░░ 15%                                             │
│ │  ...                                                                   │
└─────────────────────────────────────────────────────────────────────────┘

DIFFERENCES FROM PLAN MODE:
  - NO inline editing of task names, codes, hours
  - Status dots show actual progress (● ◐ ○)
  - Budget shows ACTUAL vs PLANNED (₪3K / ₪5K)
  - Progress bar on each zone header
  - NO add/delete task buttons
  - Click task row → opens task detail side panel (for status update, time logging)
```

### Tab 2: Tasks (flat table)

All tasks across all zones in a filterable, sortable table.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ┌──FILTERS────────────────────────────────────────────────────────────┐│
│ │ 🔍 Search  Zone: [All ▼]  Service: [All ▼]  Status: [All ▼]       ││
│ │ Assignee: [All ▼]  Priority: [All ▼]  [Overdue only ☐]           ││
│ └─────────────────────────────────────────────────────────────────────┘│
│                                                                        │
│ │Zone      │Code  │Task Name        │Status    │%   │Assign│Budget│Act│
│ │──────────│──────│─────────────────│──────────│────│──────│──────│───│
│ │GL        │BIM-CD│Clash Detection  │● Done    │100%│TW    │₪5K  │₪5K│
│ │GL        │MEP-C │MEP Coordination │● Done    │100%│LK    │₪4K  │₪4K│
│ │TP        │BIM-CD│Clash Detection  │◐ In Prog │ 65%│TW    │₪5K  │₪3K│
│ │TP        │MEP-C │MEP Coordination │○ Not Start│  0%│──    │₪4K  │₪0 │
│ │RF        │BIM-CD│Clash Detection  │○ Not Start│  0%│──    │₪5K  │₪0 │
│ │BSM/B1    │MEP-WP│Waterproofing    │🔴 Overdue │ 20%│MR    │₪3K  │₪1K│
│                                                                        │
│ 18 tasks │ 4 overdue │ Avg completion: 42%                            │
└─────────────────────────────────────────────────────────────────────────┘

TASK CLICK → opens side panel with:
  - Full task detail
  - Status update dropdown
  - Completion % slider
  - Time entry quick-add
  - Comments / discussion
  - Dependency status
  - Assignee change
```

### Tab 3: Team

Resource view — who's on this project and their workload.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Project Team                                          [+ Add Member]   │
│                                                                         │
│ ┌──PROJECT LEADER───────────────────────────────────────────────────┐  │
│ │ 👤 AM  Amit Maimoni  ·  Senior PL  ·  BIM Department             │  │
│ │        Leading this project since Mar 15, 2025                    │  │
│ └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│ │ Member      │ Position       │ Tasks │ Hours Used │ Util%│ Status   │ │
│ │ 👤 TW Tom W.│ Structural Eng │ 4     │ 80h / 120h │  67% │ 🟢 Active│ │
│ │ 👤 LK Lisa K│ MEP Coord.     │ 5     │ 95h / 100h │  95% │ 🔴 High │ │
│ │ 👤 MR Mike R│ Civil Eng.     │ 1     │ 10h / 40h  │  25% │ 🟡 Low  │ │
│ │ 👤 JB Jake B│ BIM Coord.     │ 0     │ 0h / 0h    │   0% │ ⚪ Idle │ │
│                                                                         │
│ ⚠️ Lisa K. is at 95% utilization — consider redistributing tasks      │
│ ⚠️ Jake B. has no tasks assigned                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 4: Budget & Cost

Financial tracking — planned vs actual.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Budget Overview                                       [Export XLSX]    │
│                                                                         │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│ │ Contract     │  │ Tasks Budget │  │ Actual Cost  │                  │
│ │ ₪250,000     │  │ ₪55,000      │  │ ₪32,000      │                  │
│ │              │  │ 22% of cont. │  │ 58% of tasks │                  │
│ └──────────────┘  └──────────────┘  └──────────────┘                  │
│                                                                         │
│ ── BY SERVICE TYPE ──────────────────────────────────────────────      │
│ │ Service Type      │ Budget   │ Actual  │ Variance │ Status         │ │
│ │ BIM Coordination  │ ₪30,000  │ ₪18,000 │ +₪12,000 │ 🟢 Under      │ │
│ │ MEP               │ ₪15,000  │ ₪10,000 │ +₪5,000  │ 🟢 Under      │ │
│ │ Structural        │ ₪8,000   │ ₪4,000  │ +₪4,000  │ 🟢 Under      │ │
│ │ Other             │ ₪2,000   │ ₪0      │ +₪2,000  │ 🟢 Under      │ │
│                                                                         │
│ ── BY ZONE ──────────────────────────────────────────────────────      │
│ │ Zone              │ Budget   │ Actual  │ Variance │ Progress       │ │
│ │ Building A        │ ₪45,000  │ ₪28,000 │ +₪17,000 │ ████░░ 65%    │ │
│ │   Ground Level    │ ₪17,000  │ ₪17,000 │ ₪0       │ ██████ 100%   │ │
│ │   Typical Floor   │ ₪17,000  │ ₪6,000  │ +₪11,000 │ ██░░░░ 35%   │ │
│ │   Roof            │ ₪11,000  │ ₪0      │ +₪11,000 │ ░░░░░░ 0%    │ │
│ │ Basement          │ ₪10,000  │ ₪4,000  │ +₪6,000  │ █░░░░░ 15%   │ │
│                                                                         │
│ ── CHART ──                                                            │
│ [Bar chart: budget vs actual by zone, stacked by service type]         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab 5: Milestones

Delivery milestones linked to zones and partners.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Project Milestones                                   [+ Add Milestone]  │
│                                                                         │
│ TIMELINE VIEW:                                                          │
│ Mar ──●───────●────────────●───────────○────────○── Dec                 │
│       GL Done  TP Start    BSM Start   TP Done   Handover              │
│       ✅       🔵          🔵          ○         ○                      │
│                                                                         │
│ TABLE VIEW:                                                             │
│ │ Milestone        │ Zone     │ Due Date │ Amount │ Partner  │ Status  │ │
│ │ GL Foundations   │ Ground L │ Apr 1    │ ₪20K   │ ABC Ltd  │ ✅ Done │ │
│ │ TP Structure     │ Typical  │ Jun 15   │ ₪80K   │ ABC Ltd  │ 🔵 InProg│ │
│ │ BSM Complete     │ Basement │ Jul 1    │ ₪30K   │ XYZ Co   │ ○ Pending│ │
│ │ Final Handover   │ Project  │ Dec 31   │ ₪120K  │ Client   │ ○ Pending│ │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Side Panel: Task Detail (Monitor Mode)

When clicking any task in Monitor mode, a side panel slides in from the right:

```
┌───────────────────────────────────┐
│ Task Detail                  [×]  │
│                                    │
│ BIM-CD                             │
│ Clash Detection                    │
│ Ground Level · Building A          │
│                                    │
│ ── STATUS ──────────────────────  │
│ Status: [In Progress ▼]           │
│ Priority: [🔴 High ▼]             │
│ Completion: ████████░░ [80]%      │
│                                    │
│ ── ASSIGNMENT ──────────────────  │
│ Assignee: 👤 Tom Wilson [Change]   │
│ Start: Mar 20, 2025               │
│ End: —                             │
│                                    │
│ ── BUDGET ──────────────────────  │
│ Budget: 20h · ₪5,000              │
│ Actual: 16h · ₪4,000              │
│ Remaining: 4h · ₪1,000            │
│                                    │
│ ── DEPENDENCIES ────────────────  │
│ Depends on:                        │
│ ✅ SRV-01 Site Survey (done)       │
│ ✅ STR-R Structural Review (done)  │
│ Blocks:                            │
│ ◐ OPN-C Opening Coord. (waiting)  │
│                                    │
│ ── TIME ENTRIES ────────────────  │
│ [+ Log Time]                       │
│ Mar 25 · Tom W. · 4h · "sections" │
│ Mar 24 · Tom W. · 6h · "model"    │
│ Mar 22 · Tom W. · 6h · "setup"    │
│                                    │
│ ── DISCUSSION ──────────────────  │
│ 👤 Tom: Started section A review   │
│ 👤 Amit: Please prioritize B2      │
│ [Write a comment...]               │
└───────────────────────────────────┘
```

---

## Navigation Between Modes

```
Projects List → Click project:
  If status = 'draft'  → opens PLAN mode  (/projects/:id/plan)
  If status = 'active' → opens MONITOR mode (/projects/:id)

Within Monitor mode:
  [Edit Plan] button → switches to Plan mode (for adjustments)
  
Within Plan mode:
  [Start Project ▶] → changes status to 'active', switches to Monitor mode

Project header always shows:
  [Plan] [Monitor] toggle → so PL can switch between modes anytime
```

---

## DB Changes Needed

### New columns on tasks table:

```sql
ALTER TABLE tasks ADD COLUMN start_date DATE NULL;
ALTER TABLE tasks ADD COLUMN end_date DATE NULL;
-- start_date and end_date should already exist from v8, verify they do
```

### New table: task_dependencies

```sql
CREATE TABLE task_dependencies (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  task_id         INT NOT NULL,           -- the task that depends on another
  depends_on_id   INT NOT NULL,           -- the prerequisite task
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, depends_on_id),
  CHECK(task_id != depends_on_id)         -- can't depend on itself
);

CREATE INDEX idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on_id);
```

### New API endpoints:

```
# Dependencies
GET    /api/v1/tasks/:id/dependencies       → { dependsOn: Task[], blocks: Task[] }
POST   /api/v1/tasks/:id/dependencies       → { dependsOnId }
DELETE /api/v1/task-dependencies/:id

# Project planning summary (for Start Project modal)
GET    /api/v1/projects/:id/planning-summary
  → { zones, tasks, assignedTasks, unassignedTasks, budgetTotal, warnings[] }

# Project status change
POST   /api/v1/projects/:id/start           → changes draft → active, notifies team
```

---

## Prisma Model Addition

```prisma
model TaskDependency {
  id          Int      @id @default(autoincrement())
  taskId      Int      @map("task_id")
  dependsOnId Int      @map("depends_on_id")
  createdAt   DateTime @default(now()) @map("created_at")

  task      Task @relation("TaskDependencies", fields: [taskId], references: [id], onDelete: Cascade)
  dependsOn Task @relation("TaskDependedOnBy", fields: [dependsOnId], references: [id], onDelete: Cascade)

  @@unique([taskId, dependsOnId])
  @@map("task_dependencies")
}

// Add to Task model:
model Task {
  // ... existing fields ...
  
  dependencies  TaskDependency[] @relation("TaskDependencies")
  dependedOnBy  TaskDependency[] @relation("TaskDependedOnBy")
}
```
