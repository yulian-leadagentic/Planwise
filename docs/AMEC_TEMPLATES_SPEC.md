# Templates Menu — Detailed Specification

> Every section, every field, every form, every button.

---

## Templates Menu Structure

```
📐 Templates (sidebar menu)
  ├── 📋 Service Templates        ← list of services to apply to zones
  ├── 🏗 Zone Templates           ← zone hierarchy structures
  ├── 📦 Combined Templates       ← zone structure + services together
  ├── 👥 Team Templates           ← reusable team compositions
  ├── ─────────────────
  ├── 🏷 Service Categories       ← manage: "BIM", "MEP", "Structural"
  ├── 📊 Service Phases           ← manage: "Design", "Construction", "Handover"
  └── 🏢 Project Types            ← manage: "BIM", "Management", "Buildings"
```

---

## Section 1: Service Templates

### What it is
A service template is a **reusable list of services** that can be applied to any zone in any project. When applied, all services in the template are copied into the zone with default values. The user can then adjust each service as needed.

**Example:** Template "BIM Coordination Standard" contains 5 services. When a coordinator applies it to "Tower A > Ground Floor", those 5 services appear in the zone ready to work with.

---

### 1.1 Service Templates — List Page

**Route:** `/templates/services`

```
┌─────────────────────────────────────────────────────────────────┐
│ Service Templates                          [+ New Template]     │
│                                                                  │
│ ┌──FILTERS──────────────────────────────────────────────────┐   │
│ │ 🔍 Search by name or code     Category: [All ▼]          │   │
│ └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│ │ Code     │ Name                      │ Category │ Services│Used│
│ ├──────────┼───────────────────────────┼──────────┼─────────┼────│
│ │ BC.S.1   │ BIM Coordination Standard │ BIM      │ 5       │ 12 │
│ │ BC.S.2   │ BIM Coordination Advanced │ BIM      │ 8       │ 4  │
│ │ MEP.S.1  │ MEP Standard Package      │ MEP      │ 6       │ 9  │
│ │ STR.S.1  │ Structural Review Package │ Struct.  │ 4       │ 7  │
│ │ BMS.S.1  │ BIM Management Standard   │ BIM      │ 3       │ 15 │
│ │ OPN.S.1  │ Opening Coordination      │ BIM      │ 3       │ 6  │
│                                                                  │
│ Showing 1-10 of 18                                               │
└─────────────────────────────────────────────────────────────────┘
```

**List columns:**
| Column | Source | Sortable |
|--------|--------|----------|
| Code | `templates.code` | Yes |
| Name | `templates.name` | Yes |
| Category | `templates.category` | Yes |
| Services | COUNT of `template_services` for this template | Yes |
| Used | `templates.usage_count` (how many times applied) | Yes |

**Row actions** (⋮ menu):
- Edit → opens editor
- Duplicate → creates copy with name "Copy of ..."
- Archive → soft delete (hides but doesn't delete)
- Delete → only if `usage_count = 0`

---

### 1.2 Service Template — Create / Edit Form

**Route:** `/templates/services/new` or `/templates/services/:id`

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Service Templates                                             │
│                                                                  │
│ ┌──TEMPLATE INFO────────────────────────────────────────────┐   │
│ │                                                            │   │
│ │ Template Code *    Template Name *                         │   │
│ │ ┌──────────────┐   ┌──────────────────────────────────┐    │   │
│ │ │ BC.S.1       │   │ BIM Coordination Standard        │    │   │
│ │ └──────────────┘   └──────────────────────────────────┘    │   │
│ │                                                            │   │
│ │ Category              Description                          │   │
│ │ ┌──────────────┐      ┌──────────────────────────────────┐ │   │
│ │ │ BIM        ▼ │      │ Standard BIM coordination        │ │   │
│ │ └──────────────┘      │ services for a typical zone      │ │   │
│ │                        └──────────────────────────────────┘ │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│ ┌──SERVICES LIST──────────────────────────── [+ Add Service] ┐  │
│ │                                                              │ │
│ │ │ # │ Code * │ Name *              │ Hours │ Amount │ Cat. │ Phase │ ⋮ │
│ │ ├───┼────────┼─────────────────────┼───────┼────────┼──────┼───────┼───│
│ │ │ 1 │ BIM-CD │ Clash Detection     │ 20    │ 5,000  │ BIM  │Design │ ⋮ │
│ │ │ 2 │ MEP-C  │ MEP Coordination    │ 16    │ 4,000  │ MEP  │Design │ ⋮ │
│ │ │ 3 │ STR-R  │ Structural Review   │  8    │ 2,000  │ STR  │Design │ ⋮ │
│ │ │ 4 │ OPN-C  │ Opening Coord.      │ 12    │ 3,000  │ BIM  │Constr.│ ⋮ │
│ │ │ 5 │ BIM-MA │ Model Audit         │  4    │ 1,000  │ BIM  │Handov.│ ⋮ │
│ │ │   │        │                     │       │        │      │       │   │
│ │ │   │ [+ Add row — click or Tab from last row]              │     │
│ │ │                                                            │     │
│ │ ├───────────────────────────────────┼───────┼────────┤       │     │
│ │ │ TOTALS (5 services)               │ 60 h  │ ₪15,000│       │     │
│ │ └───────────────────────────────────┴───────┴────────┘       │     │
│ └──────────────────────────────────────────────────────────────┘     │
│                                                                      │
│ [Cancel]                                              [Save Template]│
└─────────────────────────────────────────────────────────────────────┘
```

**Template info fields:**

| Field | Type | Required | Validation | Notes |
|-------|------|----------|------------|-------|
| Code | text input | Yes | Unique across templates, uppercase, max 20 chars, no spaces (use dots/dashes) | "BC.S.1", "MEP.S.2" |
| Name | text input | Yes | Max 255 chars | "BIM Coordination Standard" |
| Category | dropdown | No | Values from `service_categories` table | "BIM", "MEP", "Structural" |
| Description | textarea | No | Max 1000 chars | When to use this template |

**Service row fields (inside the table):**

| Field | Type | Required | Validation | Notes |
|-------|------|----------|------------|-------|
| # | auto | — | — | Row number, auto-increments |
| Code | text input | Yes | Max 20 chars, unique within this template | "BIM-CD", "MEP-C" |
| Name | text input | Yes | Max 255 chars | "Clash Detection" |
| Hours | number input | No | Min 0, max 9999, decimal allowed (0.5) | Default budget hours |
| Amount | number input | No | Min 0, currency format | Default budget amount ₪ |
| Category | dropdown | No | Values from `service_categories` table | Can differ from template category |
| Phase | dropdown | No | Values from `service_phases` table | "Design", "Construction", "Handover" |
| ⋮ | menu | — | — | Move up, Move down, Duplicate row, Delete row |

**Table behaviors:**
- Inline editing — click any cell to edit
- Tab moves to next cell (left to right, then next row)
- Enter on the last row creates a new empty row
- [+ Add Service] button also creates a new empty row at the bottom
- Drag rows to reorder (drag handle on left)
- Totals row auto-calculates sum of Hours and Amount
- Row ⋮ menu: Move Up, Move Down, Duplicate Row, Delete Row

---

## Section 2: Zone Templates

### What it is
A zone template is a **reusable zone hierarchy** — a tree of zones with types and names. It does NOT contain services. When applied, it creates the zone structure under a parent zone or at project root.

**Example:** Template "Standard Building" creates: Ground Floor, Typical Floor, Roof. Template "Basement 3 Levels" creates: Level -3, Level -2, Level -1.

---

### 2.1 Zone Templates — List Page

**Route:** `/templates/zones`

```
┌─────────────────────────────────────────────────────────────────┐
│ Zone Templates                                 [+ New Template] │
│                                                                  │
│ ┌──FILTERS──────────────────────────────────────────────────┐   │
│ │ 🔍 Search by name or code     Type: [All ▼]              │   │
│ └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│ │ Code     │ Name                      │ Zones │ Depth │ Used │  │
│ ├──────────┼───────────────────────────┼───────┼───────┼──────│  │
│ │ BLD      │ Standard Building         │ 3     │ 1     │ 22   │  │
│ │ BSM.3    │ Basement 3 Levels         │ 3     │ 1     │ 8    │  │
│ │ BSM.2    │ Basement 2 Levels         │ 2     │ 1     │ 14   │  │
│ │ ROAD.20  │ Road 20 Stations          │ 20    │ 1     │ 3    │  │
│ │ CROSS    │ Cross                     │ 1     │ 0     │ 5    │  │
│ │ SITE.STD │ Standard Site (2 bldg+bsm)│ 9     │ 2     │ 6    │  │
└─────────────────────────────────────────────────────────────────┘
```

**List columns:**
| Column | Source | Notes |
|--------|--------|-------|
| Code | `templates.code` | |
| Name | `templates.name` | |
| Zones | COUNT of `template_zones` | Total zone nodes in tree |
| Depth | MAX depth of template zone tree | How many levels deep |
| Used | `templates.usage_count` | |

---

### 2.2 Zone Template — Create / Edit Form

**Route:** `/templates/zones/new` or `/templates/zones/:id`

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Zone Templates                                                │
│                                                                  │
│ ┌──TEMPLATE INFO────────────────────────────────────────────┐   │
│ │                                                            │   │
│ │ Template Code *    Template Name *                         │   │
│ │ ┌──────────────┐   ┌──────────────────────────────────┐    │   │
│ │ │ BLD          │   │ Standard Building                 │    │   │
│ │ └──────────────┘   └──────────────────────────────────┘    │   │
│ │                                                            │   │
│ │ Description                                                │   │
│ │ ┌──────────────────────────────────────────────────────┐   │   │
│ │ │ Standard building with ground floor, typical, roof   │   │   │
│ │ └──────────────────────────────────────────────────────┘   │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│ ┌──ZONE TREE──────────────────────────────── [+ Add Zone]────┐  │
│ │                                                              │ │
│ │  ▼ 🏢 Building: {Building Name}                      [⋮]   │ │
│ │    ├── 📐 Level: Ground Floor                         [⋮]   │ │
│ │    ├── 📐 Level: Typical Floor  ⟲ typical             [⋮]   │ │
│ │    └── 📐 Level: Roof                                 [⋮]   │ │
│ │                                                              │ │
│ │  [+ Add root zone]                                           │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ── SELECTED ZONE DETAILS (click a zone above to edit) ──        │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ Zone Name *           Zone Type *         Code               ││
│ │ ┌──────────────────┐  ┌──────────────┐   ┌──────────────┐   ││
│ │ │ Ground Floor     │  │ Level      ▼ │   │ GL           │   ││
│ │ └──────────────────┘  └──────────────┘   └──────────────┘   ││
│ │                                                              ││
│ │ ☐ Is typical floor (represents multiple identical floors)    ││
│ │   If checked: Default count: [1]                              ││
│ │                                                              ││
│ │ Link Service Template: [None ▼]  ← optional: auto-apply     ││
│ │   services when this zone is created from template           ││
│ └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│ [Cancel]                                       [Save Template]  │
└─────────────────────────────────────────────────────────────────┘
```

**Template info fields:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| Code | text input | Yes | Unique, uppercase, max 20 chars |
| Name | text input | Yes | Max 255 chars |
| Description | textarea | No | Max 1000 chars |

**Zone node fields (each node in the tree):**

| Field | Type | Required | Validation | Notes |
|-------|------|----------|------------|-------|
| Name | text input | Yes | Max 255 chars | Can use placeholder like `{Building Name}` |
| Zone Type | dropdown | Yes | From ENUM: site, building, level, zone, area, section, wing, floor | Determines icon in tree |
| Code | text input | No | Max 50 chars | Short identifier: "GL", "TYP", "RF" |
| Is Typical | checkbox | No | — | When checked, this zone represents N identical zones |
| Typical Count | number | No (yes if typical) | Min 1, max 99 | Only visible when "Is Typical" checked |
| Link Service Template | dropdown | No | Values from service templates list | When this zone is created from template, auto-apply selected service template |

**Tree actions:**
- [+ Add Zone] → adds child under selected zone (or root if nothing selected)
- [⋮] per zone → Add Child, Move Up, Move Down, Delete
- Click zone → shows its details in the form below the tree
- Drag to reorder zones within same parent

---

## Section 3: Combined Templates

### What it is
A combined template contains BOTH a zone structure AND service templates linked to zones. When applied to a project, it creates the full structure in one action — zones with services already populated.

**Example:** "P.2BLD1BSM" creates 2 buildings + 1 basement, each zone already populated with BIM Coordination services.

---

### 3.1 Combined Templates — List Page

**Route:** `/templates/combined`

```
┌─────────────────────────────────────────────────────────────────┐
│ Combined Templates                             [+ New Template] │
│                                                                  │
│ │ Code       │ Name                          │ Zones│ Services│Used│
│ ├────────────┼───────────────────────────────┼──────┼─────────┼────│
│ │ P.2BLD1BSM │ 2 Buildings + Basement (BIM)  │ 9    │ 45      │ 6  │
│ │ P.1BLD     │ Single Building (BIM)         │ 3    │ 15      │ 11 │
│ │ P.ROAD     │ Road Project with 2 Crosses   │ 22   │ 30      │ 3  │
│ │ P.1BLD.MEP │ Single Building (MEP)         │ 3    │ 18      │ 5  │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3.2 Combined Template — Create / Edit Form

**Route:** `/templates/combined/new` or `/templates/combined/:id`

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Combined Templates                                            │
│                                                                  │
│ ┌──TEMPLATE INFO────────────────────────────────────────────┐   │
│ │ Code *          Name *                     Category        │   │
│ │ ┌────────────┐  ┌────────────────────────┐ ┌────────────┐ │   │
│ │ │ P.2BLD1BSM │  │ 2 Buildings + Basement │ │ BIM      ▼ │ │   │
│ │ └────────────┘  └────────────────────────┘ └────────────┘ │   │
│ │ Description: [Standard 2-building project with BIM...]     │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│ ┌──────────────────────┬─────────────────────────────────────┐  │
│ │ ZONE TREE            │ SERVICES for selected zone           │  │
│ │                      │                                      │  │
│ │ [+ Add Zone]         │ Service Template: [BC.S.1 ▼] [Apply]│  │
│ │                      │ [+ Add Service manually]             │  │
│ │ ▼ 🏢 Building A      │                                      │  │
│ │   ├── 📐 Ground Fl.  │ │Code │Name          │Hrs│Amount│Cat││  │
│ │   │   services: 5 ✓  │ │BIM-CD│Clash Det.   │20 │₪5K  │BIM││  │
│ │   ├── 📐 Typical ⟲   │ │MEP-C │MEP Coord    │16 │₪4K  │MEP││  │
│ │   │   services: 5 ✓  │ │STR-R │Struct. Rev  │ 8 │₪2K  │STR││  │
│ │   └── 📐 Roof        │ │OPN-C │Opening Crd  │12 │₪3K  │BIM││  │
│ │       services: 3 ✓  │ │BIM-MA│Model Audit  │ 4 │₪1K  │BIM││  │
│ │ ▼ 🏢 Building B      │ │      │             │   │     │   ││  │
│ │   ├── 📐 Ground Fl.  │ │[+ Add row]                       ││  │
│ │   │   services: 5 ✓  │ │                                   ││  │
│ │   ├── 📐 Typical ⟲   │ │Zone total: 60h  ₪15,000          ││  │
│ │   │   services: 5 ✓  │                                      │  │
│ │   └── 📐 Roof        │                                      │  │
│ │       services: 3 ✓  │                                      │  │
│ │ ▼ 🏢 Basement        │                                      │  │
│ │   ├── 📐 Level -2    │                                      │  │
│ │   │   services: 5 ✓  │                                      │  │
│ │   └── 📐 Level -1    │                                      │  │
│ │       services: 5 ✓  │                                      │  │
│ │                      │                                      │  │
│ │ ✓ = has services     │                                      │  │
│ │ (no mark) = empty    │                                      │  │
│ └──────────────────────┴──────────────────────────────────────┘  │
│                                                                  │
│ TEMPLATE TOTALS:                                                 │
│ 9 zones │ 43 services │ 420h │ ₪105,000                        │
│ By category: BIM 60% │ MEP 25% │ STR 15%                       │
│                                                                  │
│ [Cancel]                                       [Save Template]  │
└─────────────────────────────────────────────────────────────────┘
```

**Template info fields:** Same as Zone Template (code, name, category, description).

**Left panel (zone tree):** Same zone editing as Zone Templates — add zones, set types, set names, mark typical.

**Right panel (services per zone):**
- Select a zone on the left → right panel shows services for that zone
- **Apply a service template**: dropdown of service templates → [Apply] → copies services in
- **Add manually**: [+ Add Service] → empty row, fill in code/name/hours/amount
- Services are stored in `template_assignments` linked to `template_zones`
- Each zone shows "services: N ✓" badge in the tree
- Zones without services show no badge (they're just structural containers)

**How combined templates differ from zone + service separately:**
- Zone template = just the tree structure, no services
- Service template = just the list of services, no zones
- Combined = both together, with services pre-assigned to specific zones
- Combined template is the "full package" for creating a complete project structure

---

## Section 4: Team Templates

### What it is
A team template is a **saved team composition** — a list of users with their roles. When applied to a project, all team members are added to the project at once.

---

### 4.1 Team Templates — List Page

**Route:** `/templates/teams`

```
┌─────────────────────────────────────────────────────────────────┐
│ Team Templates                                 [+ New Template] │
│                                                                  │
│ │ Name                     │ Members │ Used │ Created By │       │
│ ├──────────────────────────┼─────────┼──────┼────────────│       │
│ │ Standard BIM Team        │ 5       │ 8    │ Sarah J.   │       │
│ │ MEP Coordination Team    │ 3       │ 12   │ Amit M.    │       │
│ │ Small Project Team       │ 2       │ 15   │ Sarah J.   │       │
│ │ Infrastructure Team      │ 6       │ 4    │ Mark D.    │       │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Team Template — Create / Edit Form

**Route:** `/templates/teams/new` or `/templates/teams/:id`

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Team Templates                                                │
│                                                                  │
│ ┌──TEMPLATE INFO────────────────────────────────────────────┐   │
│ │ Name *                                                     │   │
│ │ ┌─────────────────────────────────────────────────────┐    │   │
│ │ │ Standard BIM Team                                    │    │   │
│ │ └─────────────────────────────────────────────────────┘    │   │
│ └────────────────────────────────────────────────────────────┘   │
│                                                                  │
│ ┌──TEAM MEMBERS──────────────────────────── [+ Add Member]───┐  │
│ │                                                              │ │
│ │ │ 👤 │ Name             │ Position         │ Project Role   │ │ │
│ │ ├────┼──────────────────┼──────────────────┼────────────────│ │ │
│ │ │ SJ │ Sarah Johnson    │ BIM Manager      │ Project Leader │ │ │
│ │ │ TW │ Tom Wilson       │ Structural Eng.  │ Prof. Employee │ │ │
│ │ │ LK │ Lisa Kim         │ MEP Coordinator  │ MEP Coord.     │ │ │
│ │ │ MR │ Mike Ross        │ Civil Engineer   │ Prof. Employee │ │ │
│ │ │ JB │ Jake Brown       │ BIM Coordinator  │ BIM Lead       │ │ │
│ │ │    │                  │                  │                │ │ │
│ │ │ [+ Add member — search users]                             │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [Cancel]                                       [Save Template]  │
└─────────────────────────────────────────────────────────────────┘
```

**Team member fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| User | user search/select | Yes | Search by name, shows avatar + position |
| Project Role | dropdown | Yes | Values: Project Leader, BIM Manager, BIM Lead, MEP Coordinator, MEP Lead, Coordinator, Professional Employee, Viewer |

**[+ Add Member]:** Opens a searchable user dropdown. Type name → shows matching users with avatar and position. Click to add.

---

## Section 5: Service Categories

### What it is
A simple managed list of category names that can be assigned to services. Used for filtering and budget grouping.

**Default values:** BIM, MEP, Structural, Architecture, Infrastructure, Fire Protection, Acoustics

---

### 5.1 Service Categories — Page

**Route:** `/templates/categories`

```
┌─────────────────────────────────────────────────────────────────┐
│ Service Categories                                 [+ Add]      │
│                                                                  │
│ │ Name              │ Services Using │ ⋮                        │
│ ├───────────────────┼────────────────┼──                        │
│ │ BIM               │ 45             │ ⋮                        │
│ │ MEP               │ 32             │ ⋮                        │
│ │ Structural        │ 28             │ ⋮                        │
│ │ Architecture      │ 15             │ ⋮                        │
│ │ Infrastructure    │ 8              │ ⋮                        │
│ │ Fire Protection   │ 4              │ ⋮                        │
│ │ Acoustics         │ 2              │ ⋮                        │
│                                                                  │
│ [+ Add]  → inline: ┌────────────────────┐ [Save]               │
│                     │ New category name  │                       │
│                     └────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

**Fields for new/edit:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| Name | text input | Yes | Max 100 chars, unique |

**Actions per row (⋮):**
- Edit → inline text edit
- Delete → only if "Services Using" = 0. If > 0: show warning "Cannot delete — used by N services. Reassign them first."

---

## Section 6: Service Phases

### What it is
A simple managed list of phase names. Used for filtering and budget grouping.

**Default values:** Pre-Design, Design, Construction, AFC (Approved for Construction), Handover, Maintenance

---

### 6.1 Service Phases — Page

**Route:** `/templates/phases`

```
┌─────────────────────────────────────────────────────────────────┐
│ Service Phases                                     [+ Add]      │
│                                                                  │
│ │ Name              │ Services Using │ ⋮                        │
│ ├───────────────────┼────────────────┼──                        │
│ │ Pre-Design        │ 5              │ ⋮                        │
│ │ Design            │ 85             │ ⋮                        │
│ │ Construction      │ 42             │ ⋮                        │
│ │ AFC               │ 20             │ ⋮                        │
│ │ Handover          │ 12             │ ⋮                        │
│ │ Maintenance       │ 3              │ ⋮                        │
└─────────────────────────────────────────────────────────────────┘
```

Same pattern as Service Categories — simple list, inline add/edit, delete only if unused.

**Fields:** Same as categories — just a name (unique, max 100 chars).

---

## Section 7: Project Types

### What it is
A simple managed list of project types used when creating a project.

**Default values:** BIM Coordination, BIM Management, MEP Coordination, Infrastructure, Buildings, Roads, Software, Mixed

---

### 7.1 Project Types — Page

**Route:** `/templates/project-types`

```
┌─────────────────────────────────────────────────────────────────┐
│ Project Types                                      [+ Add]      │
│                                                                  │
│ │ Name              │ Projects Using │ ⋮                        │
│ ├───────────────────┼────────────────┼──                        │
│ │ BIM Coordination  │ 120            │ ⋮                        │
│ │ BIM Management    │ 85             │ ⋮                        │
│ │ MEP Coordination  │ 45             │ ⋮                        │
│ │ Infrastructure    │ 30             │ ⋮                        │
│ │ Buildings         │ 20             │ ⋮                        │
│ │ Roads             │ 8              │ ⋮                        │
│ │ Software          │ 5              │ ⋮                        │
└─────────────────────────────────────────────────────────────────┘
```

Same simple list pattern.

---

## How Templates Are Used in Projects

### When creating a new project:

```
Step 1: Create project (name, code, type, budget, dates)
Step 2: Optionally apply a Combined Template → creates full zone + service structure
Step 3: Optionally apply a Team Template → adds all members
```

### When planning within a project:

```
On the Planning tab (zone tree left, services right):

ADD A ZONE:
  [+ Add Zone] → name (unique), zone type, parent
  
  OR
  
  [Apply Zone Template] → pick template → creates zone subtree

ADD SERVICES TO A ZONE:
  Select zone → right panel →
  
  [Apply Service Template ▼] → pick template → copies all services in
  
  OR
  
  [+ Add Service] → empty row → fill manually

DUPLICATE A ZONE:
  Right-click zone → [Duplicate] → new name → copies zone + all services
```

---

## DB Tables for Templates (final, clean)

```
templates                    → id, code, name, type (service_list|zone|combined),
                               category, description, is_active, usage_count,
                               created_by, timestamps

template_services            → id, template_id FK, code, name, description,
                               default_budget_hours, default_budget_amount,
                               default_priority, category_id FK, phase_id FK,
                               sort_order, timestamps

template_zones               → id, template_id FK, parent_id (self), zone_type ENUM,
                               name, code, is_typical, typical_count, sort_order,
                               linked_service_template_id FK → templates NULL,
                               timestamps

template_zone_services       → id, template_zone_id FK, code, name, description,
  (for combined templates)     default_budget_hours, default_budget_amount,
                               default_priority, category_id FK, phase_id FK,
                               sort_order, timestamps

team_templates               → id, name, created_by FK, timestamps
team_template_members        → id, team_template_id FK, user_id FK, project_role ENUM,
                               timestamps

service_categories           → id, name (unique), timestamps
service_phases               → id, name (unique), timestamps
project_types                → id, name (unique), timestamps
```

**Note on `template_zone_services`:** This is needed for combined templates where each zone has its own specific services. Different from `template_services` which is a standalone service list template. In combined templates, a zone can either link to a service template (via `linked_service_template_id`) OR have its own services in `template_zone_services`.

---

## API Endpoints for Templates

| Method | Path | Body | Response |
|--------|------|------|----------|
| **Service Templates** | | | |
| `GET` | `/api/v1/templates?type=service_list` | — | `Template[]` |
| `POST` | `/api/v1/templates` | `{ code, name, type:'service_list', category?, description?, services: [...] }` | `Template` |
| `GET` | `/api/v1/templates/:id` | — | Template with services/zones |
| `PATCH` | `/api/v1/templates/:id` | partial | `Template` |
| `DELETE` | `/api/v1/templates/:id` | — | `{ success }` |
| `POST` | `/api/v1/templates/:id/duplicate` | `{ newName, newCode }` | `Template` |
| **Zone Templates** | | | |
| `GET` | `/api/v1/templates?type=zone` | — | `Template[]` |
| `POST` | `/api/v1/templates` | `{ code, name, type:'zone', zones: [nested tree] }` | `Template` |
| **Combined Templates** | | | |
| `GET` | `/api/v1/templates?type=combined` | — | `Template[]` |
| `POST` | `/api/v1/templates` | `{ code, name, type:'combined', zones: [...], zoneServices: [...] }` | `Template` |
| **Team Templates** | | | |
| `GET` | `/api/v1/team-templates` | — | `TeamTemplate[]` |
| `POST` | `/api/v1/team-templates` | `{ name, members: [{userId, projectRole}] }` | `TeamTemplate` |
| `PATCH` | `/api/v1/team-templates/:id` | partial | `TeamTemplate` |
| `DELETE` | `/api/v1/team-templates/:id` | — | `{ success }` |
| **Lists** | | | |
| `GET` | `/api/v1/service-categories` | — | `Category[]` |
| `POST` | `/api/v1/service-categories` | `{ name }` | `Category` |
| `PATCH` | `/api/v1/service-categories/:id` | `{ name }` | `Category` |
| `DELETE` | `/api/v1/service-categories/:id` | — | `{ success }` |
| `GET` | `/api/v1/service-phases` | — | `Phase[]` |
| `POST` | `/api/v1/service-phases` | `{ name }` | `Phase` |
| `PATCH` | `/api/v1/service-phases/:id` | `{ name }` | `Phase` |
| `DELETE` | `/api/v1/service-phases/:id` | — | `{ success }` |
| `GET` | `/api/v1/project-types` | — | `ProjectType[]` |
| `POST` | `/api/v1/project-types` | `{ name }` | `ProjectType` |
| `PATCH` | `/api/v1/project-types/:id` | `{ name }` | `ProjectType` |
| `DELETE` | `/api/v1/project-types/:id` | — | `{ success }` |
| **Apply to project** | | | |
| `POST` | `/api/v1/zones/:id/apply-service-template` | `{ templateId }` | created `Service[]` |
| `POST` | `/api/v1/projects/:id/apply-zone-template` | `{ templateId, parentZoneId? }` | created `Zone[]` |
| `POST` | `/api/v1/projects/:id/apply-combined-template` | `{ templateId }` | created zones + services |
| `POST` | `/api/v1/projects/:id/apply-team-template` | `{ teamTemplateId }` | added `ProjectMember[]` |
