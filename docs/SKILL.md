---
name: planwise-design
description: "Design system and UI rules for the Planwise application. ALWAYS use this skill when creating, editing, or styling ANY React component, page, or UI element in the Planwise codebase. Triggers include: any frontend file (.tsx, .jsx, .css), any mention of 'component', 'page', 'UI', 'design', 'style', 'layout', any shadcn/ui component usage, any Tailwind class decisions, creating new pages or features, and fixing visual bugs. This skill ensures consistent design across the entire application."
---

# Planwise Design System

Apply these rules to every UI file in the Planwise application.

## Stack
- React 18 + TypeScript + Vite
- Tailwind CSS 3.4
- shadcn/ui (Radix primitives)
- Lucide React icons
- DM Sans (UI) + JetBrains Mono (data) fonts
- Recharts for charts

## Design Direction
Precision engineering — clean, structured, confident. Dense data UI that imposes order without feeling sterile. Think Notion meets Linear meets a CAD tool.

**Principles:**
- Hierarchy through weight, not color — font-weight and size create emphasis
- Density where it matters — tables and trees compact, forms get breathing room
- Quiet until needed — actions/indicators stay muted until hover/relevant
- Monospace for data, sans-serif for labels — codes, amounts, hours in mono always

## Fonts

```
Primary: 'DM Sans', 'Segoe UI', system-ui, sans-serif
Data:    'JetBrains Mono', 'Fira Code', monospace
```

**When to use monospace:** task codes (`AS.AHW.1131`), template codes (`BC.T.1`), amounts (`₪5,000`), zone codes (`GL`), project numbers (`PRJ-2025-012`), hours (`20h`), percentages as data (`65%`).

**Never monospace:** names, labels, descriptions, navigation, buttons, badges.

### Type Scale (always use these, nothing else)

| Use | Tailwind |
|-----|----------|
| Page title | `text-xl font-bold tracking-tight` |
| Section heading | `text-[15px] font-bold` |
| Card title | `text-base font-bold` |
| Row item name | `text-sm font-semibold` |
| Body text | `text-[13px]` |
| Small label | `text-xs font-medium` |
| Caption | `text-[11px] font-medium` |
| Code/data | `text-xs font-medium font-mono` |
| Amount | `text-xs font-semibold font-mono` |
| Badge | `text-[11px] font-bold tracking-wide` |

## Colors

### Core
```
Page background:    bg-slate-50       (#F8FAFC)
Card background:    bg-white          (#FFFFFF)
Subtle surface:     bg-[#FAFBFC]
Row hover:          bg-slate-50       (#F8FAFC)
Selected:           bg-blue-50        (#EFF6FF)
Border default:     border-slate-200  (#E2E8F0)
Border light:       border-slate-100  (#F1F5F9)
Border focus:       border-blue-500   (#3B82F6)
Text primary:       text-slate-900    (#0F172A) — headings
Text body:          text-slate-700    (#334155) — content
Text secondary:     text-slate-500    (#64748B) — labels
Text muted:         text-slate-400    (#94A3B8) — captions
Text faint:         text-slate-300    (#CBD5E1) — disabled
Primary button:     bg-blue-600 hover:bg-blue-700
```

### Entity Colors (consistent everywhere)
```
Zone:        amber-600  (#D97706)  bg: amber-50
Service:     blue-600   (#2563EB)  bg: blue-50
Task:        green-600  (#16A34A)  bg: green-50
Project:     indigo-500 (#6366F1)  bg: indigo-50
Person:      violet-600 (#7C3AED)  bg: violet-50
Contract:    cyan-600   (#0891B2)  bg: cyan-50
Time:        orange-600 (#EA580C)  bg: orange-50
```

### Status Styles
```typescript
const STATUS = {
  not_started: { dot: 'bg-slate-400', text: 'text-slate-500', bg: 'bg-slate-100' },
  in_progress: { dot: 'bg-blue-500',  text: 'text-blue-600',  bg: 'bg-blue-50' },
  in_review:   { dot: 'bg-violet-500',text: 'text-violet-600',bg: 'bg-violet-50' },
  completed:   { dot: 'bg-emerald-500',text:'text-emerald-600',bg: 'bg-emerald-50' },
  on_hold:     { dot: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-50' },
  cancelled:   { dot: 'bg-red-500',   text: 'text-red-600',   bg: 'bg-red-50' },
};

const PRIORITY = {
  low:      { text: 'text-slate-500', bg: 'bg-slate-100' },
  medium:   { text: 'text-blue-600',  bg: 'bg-blue-50' },
  high:     { text: 'text-amber-600', bg: 'bg-amber-50' },
  critical: { text: 'text-red-600',   bg: 'bg-red-50' },
};
```

## Spacing & Radius

### Radius (always use these)
```
Buttons, inputs:    rounded-lg      (8px)
Cards, panels:      rounded-[14px]
Modals:             rounded-2xl     (16px)
Badges/pills:       rounded-[5px]
Dropdowns:          rounded-xl      (12px)
Icon containers:    rounded-[7px]
Avatars:            rounded-full
```

### Page Layout
```
Page padding:       px-7 py-5     (28px horizontal, 20px vertical)
Card inner:         p-5 to p-6    (20-24px)
Table row:          px-3 py-2     (12px horizontal, 8px vertical)
Modal padding:      p-5           (20px)
Between sections:   gap-4         (16px)
Between cards:      gap-4         (16px)
Between fields:     gap-4         (16px)
```

## Component Rules

### Buttons
- **Primary:** `bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-4 py-2 rounded-lg border-none`
- **Secondary:** `bg-white border border-slate-200 hover:border-slate-400 text-slate-700 text-[13px] font-semibold px-3.5 py-2 rounded-lg`
- **Ghost/Icon:** `w-[30px] h-[30px] rounded-[7px] bg-transparent hover:bg-slate-100 text-slate-300 hover:text-slate-600` — danger hover: `hover:bg-red-50 hover:text-red-600`
- **Dashed/Add:** `border border-dashed border-slate-300 hover:border-blue-500 bg-transparent hover:bg-blue-50 text-slate-500 hover:text-blue-600 text-[13px] font-semibold rounded-[7px]`
- Icon always 14px, gap-1.5 to text

### Badges / Pills
```
Background: {entityColor} at 8% opacity → bg-{color}-50 or custom bg-[{color}14]
Text: {entityColor} at full → text-{color}-600
Padding: px-2 py-0.5 (sm) or px-2.5 py-1 (md)
Radius: rounded-[5px]
Font: text-[11px] font-bold tracking-wide
```

### Cards
```
bg-white rounded-[14px] border border-slate-200
NO box-shadow (borders are enough in data-dense UIs)
Stats footer: bg-[#FAFBFC] border-t border-slate-100 px-6 py-2.5
```

### Tables
```
Header: bg-[#FAFBFC] border-b border-slate-100 text-[11px] uppercase font-semibold text-slate-400 tracking-[0.05em] px-3 py-1.5
Rows: px-3 py-2 border-b border-slate-50 hover:bg-slate-50 text-[13px]
Numbers: text-right font-mono
Actions: opacity-0 group-hover:opacity-100 (show on row hover)
Empty: text-center py-10 text-slate-400
```

### Tree Nodes
```
Row: px-2.5 py-[7px] rounded-lg hover:bg-slate-50 cursor-pointer
Selected: bg-blue-50 border border-blue-200
Indent: ml-5 (20px) per level for compact, ml-7 (28px) for spacious
Nesting line: border-l-2 border-slate-100 (zones use border-amber-200/40)
Chevron: w-3 h-3 text-slate-400, rotate-0 collapsed → rotate-90 expanded, transition-transform duration-150
Icon container: w-[22px] h-[22px] rounded-[5px] flex items-center justify-center — bg from entity color at 10%
```

### Modals
```
Overlay: bg-slate-900/35 backdrop-blur-sm animate-fade-in
Container: bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw] max-h-[85vh] overflow-auto animate-scale-in
Header: px-5 py-4 border-b border-slate-100 — title text-base font-bold
Body: p-5
Footer: px-5 py-3 border-t border-slate-100 flex justify-end gap-2
```

### Dropdown Menus
```
Container: bg-white rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] border border-black/5 p-1.5 min-w-[220px] animate-fade-in z-50
Item: w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium text-slate-700 hover:bg-slate-50
Item icon: w-7 h-7 rounded-[7px] bg-slate-100 flex items-center justify-center text-slate-500
Item subtitle: text-[11px] text-slate-400
Danger item: text-red-600 hover:bg-red-50
Divider: h-px bg-slate-100 my-1
```

### Form Inputs
```
w-full px-3 py-2.5 rounded-lg border border-slate-200 text-sm text-slate-700
focus:border-blue-500 focus:outline-none (NO ring, NO shadow)
Placeholder: text-slate-400
Label: text-[13px] font-semibold text-slate-700 mb-1.5 block
```

### Avatars
```
User: w-6 h-6 (24px tables) to w-8 h-8 (32px cards) rounded-full bg-{userColor} text-white text-[9px] font-semibold flex items-center justify-center
Empty: w-6 h-6 rounded-full bg-slate-200 border-[1.5px] border-dashed border-slate-300
```

### Progress Bar
```
Container: w-full h-1 (4px) bg-slate-200 rounded-full overflow-hidden
Fill: h-full bg-{color} rounded-full transition-all duration-400
At 100%: bg-emerald-500
```

### Toasts (sonner)
```
Position: top-right
Left accent: border-l-[3px] border-{typeColor}
Success: emerald-500, Error: red-500, Warning: amber-500, Info: blue-500
```

## Transitions
```
All hover states:   transition-all duration-150
Tree chevron:       transition-transform duration-150
Modal:              animate-scale-in (0.2s)
Dropdown:           animate-fade-in (0.15s)
Progress bars:      transition-all duration-400
```

## Entity-Specific Patterns

### Zone rows
- Amber "Zone" pill badge, bold name, dim code in parens
- Subtle amber border: `border border-amber-200/25`
- Nesting line: `border-l-2 border-amber-200/40`
- Icon: Layers icon in amber container

### Service Type rows
- Blue service icon container, "Service:" prefix, code as pill
- When expanded: child tasks with `border-l-2 border-slate-100` line
- Stats summary: "3 tasks · ₪9,000" in `text-xs text-slate-400`

### Task rows
- Green checkmark icon container
- Monospace code, normal name, right-aligned hours + amount
- Inline assignee avatar (or empty dashed circle)
- Delete button visible on hover only

## Page Layout Patterns

### List Pages (Projects, People, Templates)
Title (text-xl font-bold) + Primary button top-right → Filter bar → Table card

### Detail Pages (Template Editor, Project Detail)
Back link → Header card (icon + title + code badge + stats bar) → Section heading + content cards

### Split Panels (Project Planning)
Left panel (300px, border-right) zone tree → Right panel (flex-1) task table → Bottom bar (budget summary, border-top, bg-[#FAFBFC])

### Forms
Max-width 640px centered → White card → Fields with 16px gap → Buttons right-aligned

## Don'ts
- Never use box-shadow on cards (only borders)
- Never use outline/ring for focus (only border-color change)
- Never use colored row backgrounds (only white + hover slate-50)
- Never use gradients (except template detail icon)
- Never bold entire paragraphs
- Never use icons larger than 18px in sidebar
- Never use rounded-full except on avatars
- Never use text larger than 20px
- Never use Inter, Roboto, or system fonts — only DM Sans + JetBrains Mono
- Never use plain black #000 — use slate-900 (#0F172A) for darkest text
