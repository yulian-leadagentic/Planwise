# Planwise — Design System & UI Instructions

> Apply these rules to every screen in the application.
> Stack: React + Tailwind CSS + shadcn/ui + Lucide icons + DM Sans font

---

## 1. Design Direction

**Aesthetic:** Precision engineering — clean, structured, confident. The tool handles complex construction data so the design must impose order without feeling sterile. Think Notion meets Linear meets a CAD tool.

**Principles:**
- **Hierarchy through weight, not color** — use font-weight and size to create emphasis, not rainbow colors
- **Density where it matters** — tables and tree views should be compact. Forms and modals get breathing room
- **Quiet until needed** — actions, badges, and indicators stay muted until hovered or relevant
- **Monospace for data, sans-serif for labels** — codes, amounts, hours always in monospace. Names and labels in DM Sans

---

## 2. Typography

### Font Stack

```css
/* Primary — all UI text */
font-family: 'DM Sans', 'Segoe UI', system-ui, -apple-system, sans-serif;

/* Data — codes, amounts, hours, IDs */
font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
```

**Load via Google Fonts:**
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

### Type Scale

| Use | Size | Weight | Font | Tailwind |
|-----|------|--------|------|----------|
| Page title | 20px | 700 | DM Sans | `text-xl font-bold` |
| Section heading | 15px | 700 | DM Sans | `text-[15px] font-bold` |
| Card title | 16px | 700 | DM Sans | `text-base font-bold` |
| Row item name | 14px | 600 | DM Sans | `text-sm font-semibold` |
| Body text | 13px | 400 | DM Sans | `text-[13px]` |
| Small label | 12px | 500 | DM Sans | `text-xs font-medium` |
| Caption / meta | 11px | 500 | DM Sans | `text-[11px] font-medium` |
| Code / data value | 11-12px | 500 | JetBrains Mono | `text-xs font-medium font-mono` |
| Amount / currency | 12px | 600 | JetBrains Mono | `text-xs font-semibold font-mono` |
| Badge text | 11px | 700 | DM Sans | `text-[11px] font-bold` |

### Letter Spacing

| Context | Value | Tailwind |
|---------|-------|----------|
| Page titles | -0.02em | `tracking-tight` |
| Badge / pill text | 0.02em | `tracking-wide` |
| Table column headers | 0.05em | custom `tracking-[0.05em]` |
| Everything else | normal | (default) |

---

## 3. Color System

### Core Palette

```css
:root {
  /* Backgrounds */
  --bg-page:        #F8FAFC;    /* page background */
  --bg-card:        #FFFFFF;    /* cards, modals, panels */
  --bg-subtle:      #FAFBFC;    /* table headers, stat bars, secondary surfaces */
  --bg-hover:       #F8FAFC;    /* row/button hover */
  --bg-selected:    #EFF6FF;    /* selected tree node, active tab */
  
  /* Borders */
  --border-default: #E2E8F0;    /* card borders, dividers */
  --border-light:   #F1F5F9;    /* inner dividers, subtle separators */
  --border-focus:   #3B82F6;    /* input focus, selected item */
  --border-dashed:  #CBD5E1;    /* dashed borders for empty states, add buttons */
  
  /* Text */
  --text-primary:   #0F172A;    /* headings, primary content */
  --text-body:      #334155;    /* body text, table content */
  --text-secondary: #64748B;    /* labels, descriptions */
  --text-muted:     #94A3B8;    /* placeholders, captions, meta */
  --text-faint:     #CBD5E1;    /* disabled, inactive icons */
  
  /* Primary */
  --primary:        #2563EB;    /* primary buttons, links, active states */
  --primary-hover:  #1D4ED8;    /* primary button hover */
  --primary-light:  #EFF6FF;    /* primary backgrounds (badges, selected) */
  --primary-border: #BFDBFE;    /* selected item border */
}
```

### Semantic Colors

| Purpose | Color | Light BG | Tailwind |
|---------|-------|----------|----------|
| Primary / Action | `#2563EB` | `#EFF6FF` | `blue-600` / `blue-50` |
| Success / Complete | `#059669` | `#ECFDF5` | `emerald-600` / `emerald-50` |
| Warning / Pending | `#D97706` | `#FFFBEB` | `amber-600` / `amber-50` |
| Danger / Error | `#DC2626` | `#FEF2F2` | `red-600` / `red-50` |
| Info / Review | `#7C3AED` | `#F5F3FF` | `violet-600` / `violet-50` |
| Neutral | `#64748B` | `#F1F5F9` | `slate-500` / `slate-100` |

### Entity Colors (consistent across the app)

| Entity | Color | Use for |
|--------|-------|---------|
| Zone | `#D97706` (amber) | Zone badges, zone borders, zone icons |
| Service Type | `#2563EB` (blue) | Service icons, service pills, service group headers |
| Task | `#16A34A` (green) | Task checkmark icons, task creation |
| Project | `#6366F1` (indigo) | Project icons in navigation |
| User / Person | `#7C3AED` (violet) | Avatar fallbacks, people icons |
| Contract | `#0891B2` (cyan) | Contract-related indicators |
| Time | `#EA580C` (orange) | Clock, time entries |

### Status Colors

```typescript
const STATUS_STYLES = {
  not_started: { dot: '#94A3B8', text: '#64748B', bg: '#F1F5F9' },
  in_progress: { dot: '#3B82F6', text: '#2563EB', bg: '#EFF6FF' },
  in_review:   { dot: '#8B5CF6', text: '#7C3AED', bg: '#F5F3FF' },
  completed:   { dot: '#10B981', text: '#059669', bg: '#ECFDF5' },
  on_hold:     { dot: '#F59E0B', text: '#D97706', bg: '#FFFBEB' },
  cancelled:   { dot: '#EF4444', text: '#DC2626', bg: '#FEF2F2' },
};

const PRIORITY_STYLES = {
  low:      { text: '#64748B', bg: '#F1F5F9' },
  medium:   { text: '#2563EB', bg: '#EFF6FF' },
  high:     { text: '#D97706', bg: '#FFFBEB' },
  critical: { text: '#DC2626', bg: '#FEF2F2' },
};
```

---

## 4. Spacing & Layout

### Page Structure

```
┌──────────────────────────────────────────────────────┐
│ SIDEBAR (240px fixed)  │  MAIN CONTENT               │
│                        │  ┌──────────────────────────┐│
│                        │  │ TOP BAR (h-14)           ││
│                        │  │ breadcrumb + actions     ││
│                        │  ├──────────────────────────┤│
│                        │  │ PAGE CONTENT             ││
│                        │  │ padding: 20px 28px       ││
│                        │  │                          ││
│                        │  └──────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

### Spacing Values

| Token | Value | Tailwind | Use for |
|-------|-------|----------|---------|
| xs | 4px | `p-1` / `gap-1` | Icon-to-text inside tight components |
| sm | 6px | `p-1.5` / `gap-1.5` | Between badge elements, tight groups |
| md | 8px | `p-2` / `gap-2` | Row padding vertical, between related items |
| base | 12px | `p-3` / `gap-3` | Card inner padding, between sections |
| lg | 16px | `p-4` / `gap-4` | Modal padding, form field spacing |
| xl | 20px | `p-5` / `gap-5` | Page content padding vertical |
| 2xl | 28px | `p-7` | Page content padding horizontal |

### Radius Values

| Element | Radius | Tailwind |
|---------|--------|----------|
| Buttons | 8px | `rounded-lg` |
| Cards, panels | 14px | `rounded-[14px]` |
| Modals | 16px | `rounded-2xl` |
| Badges / pills | 5px | `rounded-[5px]` |
| Inputs | 8px | `rounded-lg` |
| Dropdown menus | 12px | `rounded-xl` |
| Avatars | 50% | `rounded-full` |
| Icon containers | 7px | `rounded-[7px]` |
| Zone type buttons | 7px | `rounded-[7px]` |

---

## 5. Component Patterns

### 5.1 Buttons

**Primary (main action):**
```
Background: #2563EB → hover: #1D4ED8
Text: white, 13px, font-weight 600
Padding: 8px 16px
Border: none
Radius: 8px
Icon: 14px, placed before text with 6px gap
Transition: background 0.15s
```
Tailwind: `bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg`

**Secondary (less emphasis):**
```
Background: white → hover: border darkens
Text: #334155, 13px, font-weight 600
Padding: 8px 14px
Border: 1px solid #E2E8F0 → hover: #94A3B8
Radius: 8px
```
Tailwind: `bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg`

**Ghost / Icon button (subtle):**
```
Background: transparent → hover: #F1F5F9
Size: 30×30px
Radius: 7px
Icon color: #B0B8C4 → hover: #475569
Danger variant hover: bg #FEF2F2, icon color #DC2626
```

**Add / Dashed button:**
```
Background: transparent → hover: #EFF6FF
Border: 1px dashed #CBD5E1 → hover: dashed #3B82F6
Text: #64748B → hover: #2563EB, 12-13px, font-weight 600
Radius: 7px
```

### 5.2 Badges / Pills

**Standard pill:**
```
Background: {color}14 (8% opacity of the color)
Text: {color}, 11px, font-weight 700
Padding: 2px 8px (sm) or 3px 10px (md)
Radius: 5px
Letter-spacing: 0.02em
```

**Entity type pills (Zone, Service, Task):**
```
Zone:    bg amber-50, text amber-600, "Zone"
Service: bg blue-50, text blue-600, service code
Task:    bg green-50, text green-600, task code
```

**Status dot + label:**
```
Dot: 7px circle, color from STATUS_STYLES
Text: 11px, font-weight 500, color from STATUS_STYLES
Gap: 4px between dot and text
```

### 5.3 Cards

**Standard card:**
```
Background: white
Border: 1px solid #E2E8F0
Radius: 14px
Shadow: none (borders are enough in data-dense UIs)
Inner padding: 20px 24px (header), 12px 16px (content areas)
```

**Card with stats footer:**
```
Same as above, plus:
Footer: background #FAFBFC, border-top 1px solid #F1F5F9
Footer padding: 10px 24px
Footer text: 12px
```

### 5.4 Data Tables

**Table header row:**
```
Background: #FAFBFC
Border-bottom: 1px solid #F1F5F9
Text: 11px, uppercase, font-weight 600, color #94A3B8, letter-spacing 0.05em
Padding: 6px 12px
Sticky: yes (when scrollable)
```

**Table body rows:**
```
Padding: 8px 12px
Border-bottom: 1px solid #F8FAFC (very subtle)
Hover: background #FAFBFC
Text: 13px, color #334155
Font-weight: 500 for names, 400 for descriptions
```

**Table cell alignment:**
```
Text columns: left-aligned
Number columns (hours, amounts): right-aligned
Status columns: left-aligned (dot + text)
Action columns: right-aligned or centered
```

**Empty table state:**
```
Padding: 40px 20px
Text-align: center
Primary text: 14px, color #64748B, font-weight 600
Secondary text: 13px, color #94A3B8
No icons or illustrations — text only
```

### 5.5 Tree Views

**Tree node row:**
```
Padding: 7px 10px
Radius: 8px
Hover: background #F8FAFC
Selected: background #EFF6FF, border 1px solid #BFDBFE
Transition: all 0.15s
```

**Nesting:**
```
Indent per level: 20-28px (marginLeft)
Connection lines: 2px solid #F1F5F9 (border-left on child container)
  → For zones: 2px solid #FDE68A60 (amber tint)
  → For services: 2px solid #F1F5F9 (neutral)
```

**Expand/collapse chevron:**
```
Size: 12-14px
Color: #94A3B8
Rotation: 0° (collapsed) → 90° (expanded)
Transition: transform 0.15s
Invisible (opacity 0) when no children
```

**Node icon container:**
```
Size: 22×22px
Radius: 5-7px
Background: {entityColor}18 (10% opacity)
Icon color: {entityColor}
```

### 5.6 Modals

**Overlay:**
```
Background: rgba(15, 23, 42, 0.35)
Backdrop-filter: blur(4px)
Animation: opacity 0→1, 0.15s ease
```

**Modal container:**
```
Background: white
Radius: 16px
Shadow: 0 25px 60px -12px rgba(0,0,0,0.25)
Width: 420-540px (content dependent)
Max-width: 92vw
Max-height: 85vh, overflow auto
Animation: opacity + translateY(8px)→0 + scale(0.97)→1, 0.2s ease
```

**Modal header:**
```
Padding: 16px 20px
Border-bottom: 1px solid #F1F5F9
Title: 16px, font-weight 700, color #0F172A
Close button: ghost icon button, top-right
```

**Modal body:**
```
Padding: 16px 20px
```

**Modal footer (when needed):**
```
Padding: 12px 20px
Border-top: 1px solid #F1F5F9
Buttons right-aligned, gap 8px
Cancel = secondary button, Confirm = primary button
```

### 5.7 Dropdown Menus

**Container:**
```
Background: white
Radius: 12px
Shadow: 0 12px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.05)
Padding: 6px
Min-width: 220px
Animation: opacity + translateY(-4px)→0, 0.15s ease
Z-index: 100
```

**Menu item:**
```
Padding: 9px 12px
Radius: 8px
Font: 13px, font-weight 500, color #334155
Hover: background #F8FAFC
Danger: color #DC2626, hover bg #FEF2F2
Gap: 10px between icon and text
```

**Menu item with icon:**
```
Icon container: 28×28px, radius 7px
Icon container bg: #F1F5F9 (or entity-specific color at 8% opacity)
Icon color: #64748B (or entity-specific color)
```

**Menu item with subtitle:**
```
Label: 13px, font-weight 500, color #334155
Subtitle: 11px, color #94A3B8, margin-top 1px
```

**Divider:**
```
Height: 1px
Background: #F1F5F9
Margin: 4px 0
```

### 5.8 Form Inputs

**Text input:**
```
Padding: 10px 12px
Border: 1px solid #E2E8F0
Radius: 8px
Font: 14px, color #334155
Focus: border-color #3B82F6 (no box-shadow, no outline)
Placeholder: color #94A3B8
```
Tailwind: `w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm focus:border-blue-500 focus:outline-none`

**Label:**
```
Font: 13px, font-weight 600, color #334155
Margin-bottom: 6px
Display: block
```

**Select / Dropdown:**
```
Same as text input styling
With chevron-down icon on right
```

**Search input (with icon):**
```
Container: flex, items-center, gap 6-8px, padding 8px 12px
Background: #F8FAFC
Border: 1px solid #F1F5F9
Radius: 8px
Icon: 14px, color #94A3B8
Input: no border, no background, font 13px
```

### 5.9 Avatars

**User avatar:**
```
Size: 24-28px (in tables/lists), 32-36px (in cards), 40-48px (in headers)
Radius: 50%
Background: user's assigned color
Text: white, 9-11px, font-weight 600, uppercase initials
If image: object-fit cover, full circle
```

**Empty avatar (unassigned):**
```
Size: same as above
Radius: 50%
Background: #E2E8F0
Border: 1.5px dashed #CBD5E1
```

**Avatar stack (multiple users):**
```
Overlap: -8px margin-left per avatar after first
Max visible: 4 + "+N" pill
"+N" pill: same size circle, bg #F1F5F9, text #64748B
```

### 5.10 Progress Bar

```
Container: width 100%, height 3-4px, bg #E2E8F0, radius same as height
Fill: width {value}%, bg {color}, radius same, transition width 0.4s ease
Complete (100%): fill color changes to #10B981 (green)
```

### 5.11 Toasts / Notifications

```
Position: top-right
Width: 360px
Background: white
Border: 1px solid #E2E8F0
Radius: 12px
Shadow: 0 8px 30px rgba(0,0,0,0.08)
Left accent border: 3px solid {type color}
  Success: #10B981
  Error: #EF4444
  Warning: #F59E0B
  Info: #3B82F6
Padding: 14px 16px
Auto-dismiss: 4 seconds
Animation: slide in from right
```

---

## 6. Page Patterns

### 6.1 List Page (Projects, People, Contracts)

```
┌─────────────────────────────────────────────────────────┐
│ Page Title                              [+ Primary Btn] │
│                                                          │
│ ┌──FILTER BAR─────────────────────────────────────────┐ │
│ │ 🔍 Search...    [Filter ▼] [Filter ▼]    [Clear]   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌──TABLE CARD──────────────────────────────────────────┐│
│ │ Column │ Column │ Column │ Column │ Column │ Actions ││
│ │ ─────────────────────────────────────────────────── ││
│ │ Row     │        │        │        │        │   ⋮   ││
│ │ Row     │        │        │        │        │   ⋮   ││
│ │ Row     │        │        │        │        │   ⋮   ││
│ ├─────────────────────────────────────────────────────┤│
│ │ Showing 1-20 of 85                    [← 1 2 3 →]  ││
│ └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- Page title: 20px, bold, color #0F172A
- Subtitle (below title): 13px, color #64748B
- Primary button: blue, top-right aligned with title
- Filter bar: light background card, search + dropdowns inline
- Table: inside a white card with 14px radius
- Row hover: #FAFBFC
- Row click: navigates to detail page
- Pagination: bottom of card, subtle design

### 6.2 Detail Page (Project Detail, Template Editor)

```
┌─────────────────────────────────────────────────────────┐
│ ← Back to [parent]                                      │
│                                                          │
│ ┌──HEADER CARD─────────────────────────────────────────┐│
│ │ [Icon] Title  [Code Badge]            [Edit] [⋮]    ││
│ │        Description text                               ││
│ │ ────────────────────────────────────────────────────  ││
│ │ 🟡 3 zones · 🔵 2 services · 🟢 12 tasks · ₪45K    ││
│ └──────────────────────────────────────────────────────┘│
│                                                          │
│ Section Title                           [+ Action Btn]  │
│ ┌──CONTENT CARD────────────────────────────────────────┐│
│ │ Content...                                            ││
│ └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- Back link: 13px, color #64748B, flex with left arrow icon
- Header card: white, 14px radius, contains icon + title + stats bar
- Stats bar: #FAFBFC background, border-top, small colored dots + counts
- Tabs (when needed): below header card, underline style, 14px font-weight 600

### 6.3 Planning / Split Panel Page

```
┌─────────────────────────────────────────────────────────┐
│ ┌──LEFT PANEL (300px)──┬──RIGHT PANEL (flex)───────────┐│
│ │ Search/filter        │ Selected item header + actions ││
│ │                      │                                ││
│ │ Tree view            │ Content (table, grouped items) ││
│ │ (scrollable)         │ (scrollable)                   ││
│ │                      │                                ││
│ └──────────────────────┴────────────────────────────────┘│
│ ┌──BOTTOM BAR (full width)──────────────────────────────┐│
│ │ Summary stats · Budget rollup · Breakdown by category  ││
│ └───────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- Left panel: 280-300px, border-right, scrollable independently
- Right panel: flex 1, scrollable independently
- Bottom bar: border-top, #FAFBFC bg, 12px text, always visible (not scrollable)
- Divider: 1px solid #E2E8F0

### 6.4 Form Page (Create/Edit)

```
┌─────────────────────────────────────────────────────────┐
│ ← Back                                                   │
│                                                          │
│ ┌──FORM CARD (max-width 640px, centered)───────────────┐│
│ │ Title                                                 ││
│ │                                                       ││
│ │ Label                                                 ││
│ │ [Input field_________________]                        ││
│ │                                                       ││
│ │ Label                Label                            ││
│ │ [Input_____]         [Select_____▼]                   ││
│ │                                                       ││
│ │ Label                                                 ││
│ │ [Textarea________________]                            ││
│ │ [_________________________]                           ││
│ │                                                       ││
│ │                          [Cancel]  [Save]             ││
│ └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- Form max-width: 640px, centered
- Field spacing: 16px between fields
- Two-column fields: use grid with gap-10
- Buttons: right-aligned, gap-8
- Form card: white, 14px radius

---

## 7. Sidebar

**Container:**
```
Width: 240px (desktop), hidden on mobile (bottom nav instead)
Background: white
Border-right: 1px solid #E2E8F0
Padding: 0
Position: fixed, full height
```

**Logo area:**
```
Height: 56px (same as top bar)
Padding: 0 16px
Display: flex, align-items center
Logo text: "AMEC" or "Planwise", 18px, font-weight 700, color #2563EB
Border-bottom: 1px solid #E2E8F0
```

**Nav items:**
```
Padding: 8px 12px
Margin: 2px 8px
Radius: 8px
Font: 14px, font-weight 500, color #64748B
Icon: 18px, same color, 10px gap to text
Hover: background #F8FAFC, color #334155
Active: background #EFF6FF, color #2563EB, font-weight 600
Active icon: color #2563EB
```

**Section labels:**
```
Padding: 16px 20px 6px
Font: 11px, uppercase, font-weight 600, color #94A3B8, letter-spacing 0.05em
```

**User section (bottom):**
```
Border-top: 1px solid #E2E8F0
Padding: 12px 16px
Avatar (32px) + Name + Role below
```

---

## 8. Top Bar

```
Height: 56px
Background: white
Border-bottom: 1px solid #E2E8F0
Padding: 0 20px
Display: flex, align-items center, justify-content space-between
```

**Left side:** Breadcrumb
```
Font: 13px, color #64748B
Separator: " > " or chevron icon
Current page: color #0F172A, font-weight 600
Home icon: 🏠 or Home text
```

**Right side:** Actions
```
Gap: 12px between items
Clock In button: green bg (#059669), white text, 13px, font-weight 600, pill-shaped
Dark mode toggle: icon button
Notifications bell: icon button with optional red dot
User avatar: 32px circle + name 13px
```

---

## 9. Interaction Patterns

### Hover

```
Rows/items:     background → #F8FAFC (0.1s ease)
Buttons:        background darkens or border darkens (0.15s ease)
Icon buttons:   background → #F1F5F9, icon color → #475569 (0.15s)
Danger hover:   background → #FEF2F2, icon/text → #DC2626
Links:          color → #2563EB (instant)
Cards:          border-color → #94A3B8 (0.15s) — only for clickable cards
```

### Focus

```
Inputs:         border-color → #3B82F6 (no box-shadow, no outline)
Buttons:        no visible focus ring in mouse mode; ring-2 ring-blue-500 in keyboard mode
```

### Transitions

```
All hover/state: transition 0.15s ease
Tree expand:     transform rotate 0.15s ease (chevron)
Modal enter:     opacity + translateY + scale 0.2s ease
Dropdown enter:  opacity + translateY 0.15s ease
Progress bar:    width 0.4s ease
```

### Loading States

```
Skeleton:        bg #F1F5F9, animate pulse
Rows:            5 skeleton rows matching column widths
Button loading:  show spinner (14px), disable button, keep same width
Page loading:    centered spinner, no text
```

---

## 10. Responsive / Mobile-First

### Breakpoints

```
Mobile:     < 768px     (base styles)
Tablet:     768-1023px  (md:)
Desktop:    1024px+     (lg:)
Wide:       1280px+     (xl:)
```

### Mobile adaptations

| Component | Mobile | Desktop |
|-----------|--------|---------|
| Sidebar | Hidden → bottom nav (5 icons) | 240px fixed sidebar |
| Split panels | Stacked vertically or tab-based | Side by side |
| Tables | Card layout (each row = card) | Traditional table |
| Modals | Full-screen bottom sheet | Centered dialog |
| Filters | Collapsible filter panel | Inline filter bar |
| Page padding | 16px | 28px |
| Add menus | Full-width bottom sheet | Dropdown positioned |

### Bottom Navigation (mobile)

```
Height: 60px
Background: white
Border-top: 1px solid #E2E8F0
5 items: Dashboard, Projects, Time, Templates, More
Icon: 20px, text below 10px
Active: color #2563EB, inactive #94A3B8
```

---

## 11. Entity-Specific Patterns

### Zone Row (in trees and lists)

```
┌─[▶]─[🏢 icon]──Zone Name──(CODE)──────stats──[+ Add]─[⋮]─┐
│                                                              │
│  Chevron  Icon container  Bold name  Dim code   Actions     │
│  14px     22×22 r7       14px/600   12px/500                │
│  #94A3B8  amber bg+icon  #1E293B    #94A3B8                │
└──────────────────────────────────────────────────────────────┘

Zone border: 1px solid #FDE68A40 (very subtle amber)
Zone background: none (or #FFFBEB08 on hover)
Nesting line: 2px solid #FDE68A60 (left border of children container)
```

### Service Type Row

```
┌─[▶]─[📋 icon]──Service: Name──[CODE pill]──stats──[×]──────┐
│                                                              │
│  Chevron  Icon container  "Service:" prefix  Pill badge     │
│  14px     28×28 r7       14px/600           11px/700        │
│  #94A3B8  blue bg+icon   #1E293B            blue bg+text    │
└──────────────────────────────────────────────────────────────┘

When expanded: child tasks shown with 2px left border line (#F1F5F9)
Stats: "3 tasks · ₪9,000" in 12px #94A3B8
```

### Task Row

```
┌──[✓ icon]──CODE──────────Name────────────hours──amount──[×]─┐
│                                                              │
│  Checkmark  Mono code    Normal name     Right-aligned data │
│  20×20 r5   11px/500     13px/500        12px mono          │
│  green bg   #64748B      #334155         #334155/600        │
└──────────────────────────────────────────────────────────────┘

Task icon container: 20-22px, radius 5-6px, bg #EFF6FF (blue) or #F0FDF4 (green)
```

---

## 12. Where to Use Monospace Font

**Always monospace (`font-mono`):**
- Task codes: `AS.AHW.1131`, `BIM-CD`, `MEP.CRD.01`
- Template codes: `BC.T.1`, `BL`, `CMB.2B1B`
- Currency amounts: `₪5,000`, `₪250,000`
- Zone codes: `GL`, `TP`, `BLD-A`
- Project numbers: `PRJ-2025-012`
- Hours: `20h`, `480min`
- Percentages when data-like: `65%`, `93%`

**Never monospace (use DM Sans):**
- Names: "Clash Detection", "Ground Level", "Building A"
- Labels: "Status", "Priority", "Service Type"
- Descriptions, notes, comments
- Navigation items
- Button labels
- Badge labels (like "Zone", "Service")

---

## 13. Tailwind Config Additions

```typescript
// tailwind.config.ts

export default {
  theme: {
    extend: {
      fontFamily: {
        sans: ['DM Sans', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }],
      },
      colors: {
        brand: {
          50: '#EFF6FF',
          100: '#DBEAFE',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
        },
      },
      borderRadius: {
        '2.5xl': '20px',
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
};
```

---

## 14. Do's and Don'ts

### Do

- Use `#0F172A` for headings, never plain black `#000`
- Use `#F8FAFC` page background, never `#fff` or gray
- Use 14px radius on all cards
- Use 8px radius on all buttons and inputs
- Use monospace for ALL data values (codes, amounts, hours)
- Show entity icons in colored containers (22-28px squares with 7px radius)
- Use subtle amber (#FDE68A) for zone-related borders and backgrounds
- Keep row actions invisible until hover (color #CBD5E1 → visible on hover)
- Animate expand/collapse with 0.15s transform rotation on chevron
- Use 2px left border lines to show tree nesting

### Don't

- Don't use box-shadow on cards (borders are enough in data-dense UIs)
- Don't use outline or ring for input focus (just change border-color)
- Don't use colored backgrounds for table rows (only white + hover #FAFBFC)
- Don't use gradients anywhere except the template icon container
- Don't bold entire paragraphs — bold only entity names and headings
- Don't use icons larger than 18px in the sidebar
- Don't stack more than 2 action buttons inline on mobile
- Don't use rounded-full on anything except avatars
- Don't use text larger than 20px anywhere except marketing pages
- Don't mix colored borders — only #E2E8F0 default, #3B82F6 focus, #FDE68A zone
