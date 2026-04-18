# AMEC — Corrected Data Model & Spec (v8)

> **Terminology locked:**
> - **Zone** = spatial/physical part of a project (building, level, area)
> - **Service Type** = category of professional work (BIM Coordination, MEP, Structural)
> - **Task** = individual work item with code, name, budget hours, budget amount
> - A task belongs to a service type within a zone, OR directly to a zone

---

## 1. The Hierarchy

```
Project: "City Hospital"
│
├── Zone: "Tower A - Ground Floor"
│   ├── Service Type: "BIM Coordination"
│   │   ├── Task: BIM-CD   "Clash Detection"        20h  ₪5,000
│   │   ├── Task: BIM-MA   "Model Audit"             4h  ₪1,000
│   │   └── Task: OPN-C    "Opening Coordination"   12h  ₪3,000
│   ├── Service Type: "MEP"
│   │   ├── Task: MEP-C    "MEP Coordination"       16h  ₪4,000
│   │   └── Task: MEP-R    "MEP Review"              8h  ₪2,000
│   ├── Service Type: "Structural"
│   │   └── Task: STR-R    "Structural Review"       8h  ₪2,000
│   │
│   └── Task: SRV-01  "Site Survey"  8h  ₪2,000    ← directly on zone, no service type
│
├── Zone: "Tower A - Typical Floor"
│   ├── Service Type: "BIM Coordination"
│   │   ├── Task: BIM-CD   "Clash Detection"        20h  ₪5,000
│   │   └── ...
│   └── ...
│
├── Zone: "Tower A - Roof"
│   └── Task: RF-INS  "Roof Inspection"  6h  ₪1,500  ← directly on zone
│
└── Zone: "Basement"
    ├── Service Type: "MEP"
    │   └── Task: MEP-WP   "Waterproofing Review"  10h  ₪3,000
    └── ...
```

**Key rules:**
1. A zone can have zero or many service types
2. A service type groups related tasks within a zone
3. A task MUST belong to a zone
4. A task CAN optionally belong to a service type (if null → it's directly under the zone)
5. A user/employee can be assigned to a specific task

---

## 2. Database Tables

### zones (unchanged)

```
┌───────────────────────────────────────┐
│              zones                     │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ project_id      INT FK → projects     │
│ parent_id       INT FK → self NULL    │
│ zone_type       ENUM('site',          │
│                  'building','level',  │
│                  'zone','area',       │
│                  'section','wing',    │
│                  'floor')             │
│                 DEFAULT 'zone'        │
│ name            VARCHAR(255)          │
│ code            VARCHAR(50) NULL      │
│ area_sqm        DECIMAL(10,2) NULL    │
│ path            VARCHAR(1000)         │
│ depth           INT DEFAULT 0         │
│ sort_order      INT DEFAULT 0         │
│ description     TEXT NULL             │
│ is_typical      BOOLEAN DEFAULT false │
│ typical_count   INT DEFAULT 1         │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
│ deleted_at      TIMESTAMP NULL        │
│                                       │
│ UNIQUE(project_id, name)              │
└───────────────────────────────────────┘
```

### zone_service_types (the grouping layer — NEW)

This is the link between a zone and a service type. It says "this zone has BIM Coordination work in it."

```
┌───────────────────────────────────────┐
│       zone_service_types               │  ← NEW: links zone to service type
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ zone_id         INT FK → zones        │
│ service_type_id INT FK → service_types│
│ sort_order      INT DEFAULT 0         │
│ created_at      TIMESTAMP             │
│                                       │
│ UNIQUE(zone_id, service_type_id)      │  ← a zone can have each type only once
└───────────────────────────────────────┘
```

### service_types (the managed list — was "service_categories")

```
┌───────────────────────────────────────┐
│        service_types                   │  ← renamed from service_categories
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ name            VARCHAR(100) UNIQUE   │  ← "BIM Coordination", "MEP", "Structural"
│ code            VARCHAR(20) NULL      │  ← "BIM", "MEP", "STR"
│ color           VARCHAR(7) NULL       │  ← hex color for UI grouping
│ sort_order      INT DEFAULT 0         │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
└───────────────────────────────────────┘
```

### tasks (the actual work items)

```
┌───────────────────────────────────────┐
│              tasks                     │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ zone_id         INT FK → zones        │  ← REQUIRED: every task is in a zone
│ project_id      INT FK → projects     │  ← denormalized for fast queries
│ service_type_id INT FK → service_types│  ← OPTIONAL: null = directly under zone
│                          NULL         │
│                                       │
│ code            VARCHAR(50)           │  ← "BIM-CD", "MEP-C", "SRV-01"
│ name            VARCHAR(255)          │  ← "Clash Detection"
│ description     TEXT NULL             │
│                                       │
│ ── BUDGET ──                          │
│ budget_hours    DECIMAL(10,2) NULL    │
│ budget_amount   DECIMAL(14,2) NULL    │
│                                       │
│ ── PHASE (optional grouping) ──       │
│ phase_id        INT FK → phases NULL  │  ← "Design", "Construction", "Handover"
│                                       │
│ ── STATUS ──                          │
│ status          ENUM('not_started',   │
│                  'in_progress',       │
│                  'in_review',         │
│                  'completed',         │
│                  'on_hold',           │
│                  'cancelled')         │
│                 DEFAULT 'not_started' │
│ priority        ENUM('low','medium',  │
│                  'high','critical')   │
│                 DEFAULT 'medium'      │
│ completion_pct  INT DEFAULT 0         │
│                                       │
│ start_date      DATE NULL             │
│ end_date        DATE NULL             │
│ is_archived     BOOLEAN DEFAULT false │
│ created_by      INT FK → users        │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
│ deleted_at      TIMESTAMP NULL        │
└───────────────────────────────────────┘

EXAMPLES:
  id │ zone_id │ service_type_id │ code   │ name                  │ hours│ amount
  ───┼─────────┼─────────────────┼────────┼───────────────────────┼──────┼───────
  1  │ 7 (GL)  │ 1 (BIM Coord)   │ BIM-CD │ Clash Detection       │ 20   │ 5000
  2  │ 7 (GL)  │ 1 (BIM Coord)   │ BIM-MA │ Model Audit           │  4   │ 1000
  3  │ 7 (GL)  │ 2 (MEP)         │ MEP-C  │ MEP Coordination      │ 16   │ 4000
  4  │ 7 (GL)  │ NULL            │ SRV-01 │ Site Survey            │  8   │ 2000  ← no service type
  5  │ 9 (Roof)│ NULL            │ RF-INS │ Roof Inspection        │  6   │ 1500  ← no service type
```

### task_assignees (who works on each task)

```
┌───────────────────────────────────────┐
│       task_assignees                   │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ task_id         INT FK → tasks        │
│ user_id         INT FK → users        │
│ role            VARCHAR(50) NULL      │  ← their role on THIS task
│ hourly_rate     DECIMAL(10,2) NULL    │
│ start_date      DATE NULL             │
│ end_date        DATE NULL             │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
│ deleted_at      TIMESTAMP NULL        │
│ UNIQUE(task_id, user_id)              │
└───────────────────────────────────────┘
```

### task_comments (discussion per task)

```
┌───────────────────────────────────────┐
│      task_comments                     │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ task_id         INT FK → tasks        │
│ user_id         INT FK → users        │
│ parent_id       INT FK → self NULL    │
│ content         TEXT                  │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
│ deleted_at      TIMESTAMP NULL        │
└───────────────────────────────────────┘
```

### phases (simple managed list)

```
┌───────────────────────────────────────┐
│            phases                      │  ← renamed from service_phases
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ name            VARCHAR(100) UNIQUE   │  ← "Design", "Construction", "Handover"
│ sort_order      INT DEFAULT 0         │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
└───────────────────────────────────────┘
```

### time_entries (references tasks)

```
┌───────────────────────────────────────┐
│          time_entries                   │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ user_id         INT FK → users        │
│ time_clock_id   INT FK → time_clock   │
│                          NULL         │
│ project_id      INT FK → projects NULL│  ← project-level hours
│ task_id         INT FK → tasks NULL   │  ← task-level hours
│ date            DATE                  │
│ minutes         INT                   │
│ note            TEXT NULL             │
│ is_billable     BOOLEAN DEFAULT true  │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
│ deleted_at      TIMESTAMP NULL        │
│                                       │
│ CHECK: project_id IS NOT NULL         │
│   OR task_id IS NOT NULL              │
└───────────────────────────────────────┘
```

---

## 3. Templates (aligned to Zone → Service Type → Task)

### templates (master table)

```
┌───────────────────────────────────────┐
│           templates                    │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ code            VARCHAR(50) UNIQUE    │  ← "BC.T.1", "ZN.BLD", "CMB.2B1B"
│ name            VARCHAR(255)          │
│ type            ENUM('task_list',     │  ← list of tasks (optionally grouped by service type)
│                  'zone',              │  ← zone hierarchy structure
│                  'combined')          │  ← zones + tasks together
│ category        VARCHAR(100) NULL     │
│ description     TEXT NULL             │
│ is_active       BOOLEAN DEFAULT true  │
│ usage_count     INT DEFAULT 0         │
│ created_by      INT FK → users        │
│ created_at      TIMESTAMP             │
│ updated_at      TIMESTAMP             │
│ deleted_at      TIMESTAMP NULL        │
└───────────────────────────────────────┘
```

### template_tasks (the tasks inside a task_list template)

```
┌───────────────────────────────────────┐
│       template_tasks                   │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ template_id     INT FK → templates    │
│ service_type_id INT FK → service_types│  ← OPTIONAL: null = task not grouped
│                          NULL         │
│ code            VARCHAR(50)           │  ← "BIM-CD"
│ name            VARCHAR(255)          │  ← "Clash Detection"
│ description     TEXT NULL             │
│ default_budget_hours DECIMAL(10,2)    │  ← 20
│ default_budget_amount DECIMAL(14,2)   │  ← 5000
│ default_priority ENUM(...)            │
│ phase_id        INT FK → phases NULL  │
│ sort_order      INT DEFAULT 0         │
│ created_at      TIMESTAMP             │
└───────────────────────────────────────┘

EXAMPLE — Template "BIM Coordination Standard" (BC.T.1):

  id │ service_type_id    │ code   │ name                 │ hours│ amount
  ───┼────────────────────┼────────┼──────────────────────┼──────┼───────
  1  │ 1 (BIM Coord)      │ BIM-CD │ Clash Detection      │ 20   │ 5000
  2  │ 1 (BIM Coord)      │ BIM-MA │ Model Audit          │  4   │ 1000
  3  │ 1 (BIM Coord)      │ OPN-C  │ Opening Coordination │ 12   │ 3000
  4  │ 2 (MEP)            │ MEP-C  │ MEP Coordination     │ 16   │ 4000
  5  │ 2 (MEP)            │ MEP-R  │ MEP Review           │  8   │ 2000
  6  │ 3 (Structural)     │ STR-R  │ Structural Review    │  8   │ 2000
  7  │ NULL               │ SRV-01 │ Site Survey           │  8   │ 2000  ← no service type

When applied to a zone, ALL tasks get copied.
The service_type grouping is maintained — zone_service_types rows are auto-created.
```

### template_zones (zone structure in zone/combined templates)

```
┌───────────────────────────────────────┐
│       template_zones                   │
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ template_id     INT FK → templates    │
│ parent_id       INT FK → self NULL    │
│ zone_type       ENUM(...)             │
│ name            VARCHAR(255)          │
│ code            VARCHAR(50) NULL      │
│ is_typical      BOOLEAN DEFAULT false │
│ typical_count   INT DEFAULT 1         │
│ sort_order      INT DEFAULT 0         │
│ linked_task_template_id INT FK        │  ← for combined: which task_list template
│                   → templates NULL    │     to auto-apply when zone is created
│ created_at      TIMESTAMP             │
└───────────────────────────────────────┘
```

### template_zone_tasks (tasks embedded directly in combined template zones)

```
┌───────────────────────────────────────┐
│     template_zone_tasks                │  ← for combined templates only
│───────────────────────────────────────│
│ id              INT PK AUTO           │
│ template_zone_id INT FK               │
│ service_type_id INT FK → service_types│
│                          NULL         │
│ code            VARCHAR(50)           │
│ name            VARCHAR(255)          │
│ description     TEXT NULL             │
│ default_budget_hours DECIMAL(10,2)    │
│ default_budget_amount DECIMAL(14,2)   │
│ default_priority ENUM(...)            │
│ phase_id        INT FK → phases NULL  │
│ sort_order      INT DEFAULT 0         │
│ created_at      TIMESTAMP             │
└───────────────────────────────────────┘
```

---

## 4. Template Sections — Updated UI

### 4.1 Task List Templates

A task list template contains tasks, optionally grouped by service type.

**Editor:**

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Templates    BIM Coordination Standard (BC.T.1)       [Save] │
│                                                                  │
│ Code: [BC.T.1]  Name: [BIM Coordination Standard]               │
│ Category: [BIM ▼]  Description: [Standard BIM tasks...]         │
│                                                                  │
│ ┌──TASKS──────────────────────────────────── [+ Add Task]────┐  │
│ │                                                              │ │
│ │ ── BIM Coordination ─────────────────────── (service type)  │ │
│ │ │ Code   │ Name                │ Hours│Amount│Phase   │ Prio│ │ │
│ │ │ BIM-CD │ Clash Detection     │ 20   │₪5,000│Design  │ Med │ │ │
│ │ │ BIM-MA │ Model Audit         │  4   │₪1,000│Design  │ Med │ │ │
│ │ │ OPN-C  │ Opening Coord.      │ 12   │₪3,000│Constr. │ High│ │ │
│ │                                                              │ │
│ │ ── MEP ──────────────────────────────────── (service type)  │ │
│ │ │ MEP-C  │ MEP Coordination    │ 16   │₪4,000│Design  │ Med │ │ │
│ │ │ MEP-R  │ MEP Review          │  8   │₪2,000│Design  │ Low │ │ │
│ │                                                              │ │
│ │ ── Structural ───────────────────────────── (service type)  │ │
│ │ │ STR-R  │ Structural Review   │  8   │₪2,000│Design  │ Med │ │ │
│ │                                                              │ │
│ │ ── (No service type) ────────────────────── (ungrouped)     │ │
│ │ │ SRV-01 │ Site Survey          │  8   │₪2,000│Design  │ Low │ │ │
│ │                                                              │ │
│ │ TOTALS: 7 tasks │ 76h │ ₪19,000                             │ │
│ │ By service type: BIM Coord: ₪9K │ MEP: ₪6K │ STR: ₪2K      │ │
│ └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Task row fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Code | text | Yes | Unique within template |
| Name | text | Yes | The task name |
| Service Type | dropdown | No | Pick from service_types list. NULL = ungrouped |
| Hours | number | No | Default budget hours |
| Amount | number | No | Default budget amount ₪ |
| Phase | dropdown | No | From phases list |
| Priority | dropdown | No | low / medium / high / critical |

**[+ Add Task]** → new row, user picks service type (or leaves blank for direct-on-zone).

The tasks display **grouped by service type** with section headers. Ungrouped tasks (service_type = null) appear at the bottom under "(No service type)".

---

### 4.2 Zone Templates (unchanged from v7)

Just the zone hierarchy tree. No tasks inside.

Each zone can optionally link to a task list template via `linked_task_template_id` — meaning "when this zone is created, auto-apply that task template."

---

### 4.3 Combined Templates

Zone tree on the left, tasks on the right per selected zone — grouped by service type.

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Templates    2 Buildings + Basement BIM (CMB.2B1B)    [Save] │
│                                                                  │
│ Code: [CMB.2B1B]  Name: [2 Buildings + Basement BIM]            │
│                                                                  │
│ ┌──────────────────────┬─────────────────────────────────────┐  │
│ │ ZONE TREE            │ TASKS for: Tower A > Ground Floor   │  │
│ │                      │                                      │  │
│ │ [+ Add Zone]         │ [Apply Task Template ▼] [+ Add Task]│  │
│ │                      │                                      │  │
│ │ ▼ 🏢 Tower A         │ ── BIM Coordination ──               │  │
│ │   ● Ground Floor ←   │ │BIM-CD│Clash Detection │20h│₪5K   ││  │
│ │     tasks: 5 ✓       │ │BIM-MA│Model Audit     │ 4h│₪1K   ││  │
│ │   ○ Typical ⟲        │                                      │  │
│ │     tasks: 5 ✓       │ ── MEP ──                             │  │
│ │   ○ Roof             │ │MEP-C │MEP Coord       │16h│₪4K   ││  │
│ │     tasks: 2         │                                      │  │
│ │ ▶ 🏢 Tower B         │ ── (No service type) ──              │  │
│ │ ▶ 🏢 Basement        │ │SRV-01│Site Survey     │ 8h│₪2K   ││  │
│ │                      │                                      │  │
│ │                      │ Zone total: 5 tasks │ 53h │ ₪17K   │  │
│ └──────────────────────┴──────────────────────────────────────┘  │
│                                                                  │
│ TEMPLATE TOTALS: 9 zones │ 35 tasks │ 350h │ ₪95,000           │
│ By service type: BIM Coord ₪45K │ MEP ₪30K │ STR ₪15K │ ₪5K  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Project Planning — How It Works

### The Planning Tab

When the user opens a project and goes to the **Planning** tab:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Project: City Hospital                                                   │
│ [Overview] [Planning] [Team] [Contracts] [Cost] [Reports]               │
│                                                                          │
│ ┌─────────────────────┬──────────────────────────────────────────────┐  │
│ │ ZONES               │ TASKS for: Tower A > Ground Floor            │  │
│ │                     │                                               │  │
│ │ [+ Zone] [Template▼]│ [Apply Task Template ▼] [+ Task] [Dup Zone] │  │
│ │                     │                                               │  │
│ │ ▼ 🏢 Tower A        │ ── BIM Coordination ──────────────────────── │  │
│ │   ● Ground Fl. ←    │ │Code  │Name            │Hrs│₪Amt │Assignee││  │
│ │   ○ Typical ⟲ (×14) │ │BIM-CD│Clash Detection │20 │5,000│Tom W. ▼││  │
│ │   ○ Roof            │ │BIM-MA│Model Audit     │ 4 │1,000│— ▼     ││  │
│ │ ▶ 🏢 Tower B        │ │OPN-C │Opening Coord.  │12 │3,000│Lisa K.▼││  │
│ │ ▶ 🏢 Basement       │                                               │  │
│ │                     │ ── MEP ──────────────────────────────────── │  │
│ │                     │ │MEP-C │MEP Coordination│16 │4,000│Lisa K.▼││  │
│ │                     │ │MEP-R │MEP Review      │ 8 │2,000│— ▼     ││  │
│ │                     │                                               │  │
│ │                     │ ── (Ungrouped) ─────────────────────────── │  │
│ │                     │ │SRV-01│Site Survey     │ 8 │2,000│Mike R.▼││  │
│ │                     │                                               │  │
│ │                     │ Zone: 6 tasks │ 68h │ ₪17,000               │  │
│ │                     │                                               │  │
│ ├─────────────────────┴──────────────────────────────────────────────┤  │
│ │ BUDGET SUMMARY                                                      │  │
│ │ Project budget: ₪250,000  │  Contract: ₪250,000                    │  │
│ │ All tasks total: ₪180,000 │  Remaining: ₪70,000 (28%)             │  │
│ │                                                                      │  │
│ │ By service type: BIM Coord ₪90K│ MEP ₪50K│ STR ₪25K│ Other ₪15K  │  │
│ │ By phase:        Design ₪120K  │ Constr. ₪45K │ Handover ₪15K     │  │
│ │ By zone:         Tower A ₪55K  │ Tower B ₪52K │ Basement ₪38K     │  │
│ └────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### The process step by step:

**Step 1: Add zones** (left panel)
- Click [+ Zone] → modal: name, zone type, parent zone
- OR click [Template ▼] → apply a zone template → creates zone hierarchy
- Zone names must be unique within the project

**Step 2: Select a zone** (click it in the tree)
- Right panel shows tasks for this zone, grouped by service type

**Step 3: Add tasks** to the selected zone
- **OPTION A — Apply template:** Click [Apply Task Template ▼] → pick one → all template tasks copied in, grouped by their service types. `zone_service_types` rows auto-created for each service type present.
- **OPTION B — Manual:** Click [+ Task] → new empty row. User fills: code, name, hours, amount, service type (dropdown, optional), phase, priority.

**Step 4: Assign employees** (inline)
- Each task row has an "Assignee" dropdown → search/select user
- This creates a `task_assignees` row
- Multiple assignees: click assignee cell → popover to add more

**Step 5: Duplicate a zone** (optional)
- Click [Dup Zone] or right-click zone → "Duplicate"
- Modal: enter new zone name (must be unique)
- All tasks + service type groupings copied to new zone
- Assignees NOT copied (they need to be set per zone)

---

## 6. What Happens When Template Is Applied to a Zone

```
User selects zone "Tower A - Ground Floor"
User clicks [Apply Task Template] → picks "BIM Coordination Standard" (BC.T.1)

SYSTEM DOES:

1. Read template_tasks where template_id = BC.T.1
   Found: 7 tasks (3 BIM Coord, 2 MEP, 1 Structural, 1 ungrouped)

2. For each unique service_type_id in the template tasks:
   → Create zone_service_types row: (zone_id=7, service_type_id=1)  // BIM Coord
   → Create zone_service_types row: (zone_id=7, service_type_id=2)  // MEP
   → Create zone_service_types row: (zone_id=7, service_type_id=3)  // Structural
   (Skip if zone already has that service type)

3. For each template_task:
   → Create tasks row:
     zone_id = 7 (Ground Floor)
     project_id = 1 (City Hospital)
     service_type_id = template_task.service_type_id (or NULL)
     code = template_task.code
     name = template_task.name
     budget_hours = template_task.default_budget_hours
     budget_amount = template_task.default_budget_amount
     phase_id = template_task.phase_id
     priority = template_task.default_priority
     status = 'not_started'

4. Return created tasks to UI → table refreshes showing all tasks grouped by service type
```

---

## 7. Budget Rollup — Complete

### Endpoint: GET /api/v1/projects/:id/budget-summary

```sql
-- By zone (each zone's task totals)
SELECT 
  z.id, z.name, z.path, z.depth,
  COALESCE(SUM(t.budget_hours), 0) as total_hours,
  COALESCE(SUM(t.budget_amount), 0) as total_amount,
  COUNT(t.id) as task_count
FROM zones z
LEFT JOIN tasks t ON t.zone_id = z.id AND t.deleted_at IS NULL AND t.is_archived = false
WHERE z.project_id = :projectId AND z.deleted_at IS NULL
GROUP BY z.id
ORDER BY z.path;

-- By service type
SELECT 
  st.id, st.name, st.code, st.color,
  COALESCE(SUM(t.budget_hours), 0) as total_hours,
  COALESCE(SUM(t.budget_amount), 0) as total_amount,
  COUNT(t.id) as task_count
FROM tasks t
LEFT JOIN service_types st ON st.id = t.service_type_id
WHERE t.project_id = :projectId AND t.deleted_at IS NULL
GROUP BY st.id;
-- NOTE: tasks with service_type_id = NULL grouped as "Ungrouped"

-- By phase
SELECT 
  p.id, p.name,
  COALESCE(SUM(t.budget_hours), 0) as total_hours,
  COALESCE(SUM(t.budget_amount), 0) as total_amount
FROM tasks t
LEFT JOIN phases p ON p.id = t.phase_id
WHERE t.project_id = :projectId AND t.deleted_at IS NULL
GROUP BY p.id;

-- Project totals
SELECT
  COALESCE(SUM(t.budget_hours), 0) as total_hours,
  COALESCE(SUM(t.budget_amount), 0) as total_amount,
  COUNT(t.id) as total_tasks
FROM tasks t
WHERE t.project_id = :projectId AND t.deleted_at IS NULL AND t.is_archived = false;

-- Actual spent (from time entries)
SELECT
  COALESCE(SUM(te.minutes), 0) / 60.0 as actual_hours,
  COALESCE(SUM(te.minutes / 60.0 * COALESCE(ta.hourly_rate, 0)), 0) as actual_cost
FROM time_entries te
LEFT JOIN task_assignees ta ON ta.task_id = te.task_id AND ta.user_id = te.user_id
WHERE te.task_id IN (SELECT id FROM tasks WHERE project_id = :projectId AND deleted_at IS NULL)
  AND te.deleted_at IS NULL;
```

### Where budget shows:

| Location | What it shows |
|----------|---------------|
| Planning tab (bottom) | Zone total, project total, by service type, by phase, vs contract |
| Project Cost tab | Full breakdown charts + tables with actual vs budget |
| Reports → Cost | Cross-project, filterable, exportable |
| Zone row in tree | Small badge: "68h │ ₪17K" next to zone name |

---

## 8. Templates Menu — Final Structure

```
📐 Templates (sidebar)
  ├── 📋 Task Templates           ← list of tasks grouped by service type
  ├── 🏗 Zone Templates           ← zone hierarchy structures
  ├── 📦 Combined Templates       ← zones + tasks together
  ├── 👥 Team Templates           ← reusable team compositions
  ├── ─────────────────
  ├── 🏷 Service Types            ← manage: "BIM Coordination", "MEP", "Structural"
  ├── 📊 Phases                   ← manage: "Design", "Construction", "Handover"
  └── 🏢 Project Types            ← manage: "BIM", "Management", "Buildings"
```

---

## 9. Complete Table List

```
CORE:           users, projects, project_members               = 3

ZONES:          zones                                           = 1

SERVICE TYPES:  service_types, zone_service_types               = 2

TASKS:          tasks, task_assignees, task_comments            = 3

CONTRACTS:      contracts, contract_items, contract_milestones,
                contract_allocations, change_orders,
                billings, contacts, expenses, terms             = 9

TEMPLATES:      templates, template_tasks, template_zones,
                template_zone_tasks,
                team_templates, team_template_members           = 6

TIME:           work_schedules, calendar_days,
                time_clock, time_entries                        = 4

LOOKUP:         roles, role_modules, modules,
                project_types, service_types (above),
                phases                                          = 5*

SYSTEM:         activity_logs, notifications, email_logs        = 3

TOTAL: 36 tables
(* service_types counted once in SERVICE TYPES section)
```

---

## 10. API Changes

### New/changed endpoints:

```
# Service Types (managed list)
GET    /api/v1/service-types
POST   /api/v1/service-types         { name, code?, color? }
PATCH  /api/v1/service-types/:id     { name?, code?, color? }
DELETE /api/v1/service-types/:id     (only if unused)

# Phases (managed list)
GET    /api/v1/phases
POST   /api/v1/phases                { name }
PATCH  /api/v1/phases/:id            { name }
DELETE /api/v1/phases/:id            (only if unused)

# Tasks (work items) — renamed from services
GET    /api/v1/tasks?zoneId&projectId&serviceTypeId&phaseId&status&priority
GET    /api/v1/tasks/mine
POST   /api/v1/tasks                 { zoneId, serviceTypeId?, code, name, budgetHours?, budgetAmount?, phaseId?, priority? }
GET    /api/v1/tasks/:id
PATCH  /api/v1/tasks/:id             partial
DELETE /api/v1/tasks/:id

# Task assignees
POST   /api/v1/tasks/:id/assignees   { userId, role?, hourlyRate? }
DELETE /api/v1/task-assignees/:id

# Task comments
GET    /api/v1/tasks/:id/comments
POST   /api/v1/tasks/:id/comments    { content, parentId? }

# Zone task template application
POST   /api/v1/zones/:id/apply-task-template    { templateId }
POST   /api/v1/zones/:id/duplicate              { newName }

# Budget
GET    /api/v1/projects/:id/budget-summary

# Templates
GET    /api/v1/templates?type=task_list|zone|combined
POST   /api/v1/templates             { code, name, type, tasks?: [...], zones?: [...] }
GET    /api/v1/templates/:id
PATCH  /api/v1/templates/:id
DELETE /api/v1/templates/:id
POST   /api/v1/templates/:id/duplicate
```
