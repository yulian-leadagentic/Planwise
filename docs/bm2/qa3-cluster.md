# QA3 · Fix cluster (Projects screen · New-Project Team · Contacts/Customers)

> Round-3 fixes on staging (2026-08-31). Decisions locked with Yulian. The task-add blocker is its
> own spec (`qa3-task-add.md`). Each commit below is standalone; **verify-first and surface
> reservations before coding**; design system + **dark: variants** mandatory; frozen: SSO, PERT,
> people-filter, 3-level grouping. Verify each: `pnpm --filter api build && pnpm --filter web
> typecheck && build && lint`, then a **runtime check on staging** (not build-green).

---

## Commit A · `fix/project-list-category-and-filters` (items 1, 2)

**1 — Category inline edit (project list).** The Category cell isn't inline-editable. Add in-cell edit
(mirror the status / role-holder in-cell editors already on `project-list-page.tsx`): click the
Category cell → a `<select>` sourced from **ProjectType** (same source PR-021 set for New-Project) →
`PATCH /projects/:id` with the new type → optimistic + invalidate `['projects']`; `stopPropagation`
so it doesn't navigate. Gate on `projects:write`.

**2 — Column filters must be dynamic.** The per-column filter (`ColumnHeaderWithFilter` on
`project-list-page.tsx`) lists **all possible** values. Change each column's filter options to the
**distinct values actually present in the loaded rows** (e.g. Category, Status, role columns) — derive
the option set from the current data, not the full enum/catalog. Empty→hide the option.

**DoD:** Category is editable inline and persists; each column filter offers only values that exist in
the visible data.

---

## Commit B · `fix/new-project-team-picker` (item 4)

**Root:** the New-Project **TEAM** section renders **every** role type as its own stacked `<select>`
→ endless scroll (`project-form-page.tsx`).

**Fix (decision: add-role picker).** Replace the stacked selects with a compact **"Add team member"**
control: a list showing only the assignments **added so far** (role + person as removable rows/chips),
plus a single **"+ Add role"** button → pick a **role type** (all types available, per PR-023) → pick a
**person** (reuse `PeopleMultiSelect`/person picker) → adds a row. All optional; nothing forced. This
keeps "all roles addable" (PR-023) while rendering only what's used — no infinite scroll.

**DoD:** New-Project Team shows no long scroll; you add only the roles you need (any role type), each
optional; removing a row works; created project reflects the assignments.

---

## Commit C · `fix/new-contact-person-only` (item 8)

On the **Contacts** screen, **"New Contact"** must open the **Person** form directly — no
Person/Organization toggle (`contacts-page.tsx` New-Contact menu ~:335/:368 currently offers both, and
the Add-Business-Partner modal shows the toggle). Org creation stays only in Partners (consistent with
PR-025). Drop the "Organization" option from the New-Contact path; open Person straight away.

**DoD:** New Contact → Person form only; no way to create an Organization from the Contacts New-Contact
action.

---

## Commit D · `fix/contacts-customers` (items 5, 6) — the core cluster

**Verify-first and surface reservations** — this touches the customer/role-tag model; flag anything
that conflicts with the customer definition (PR-022, Amit).

**5 — Customer-contact add is over-permissive.** When adding a customer contact (on a project, or a
customer card), the picker must offer **only contacts belonging to that customer org** and must
**exclude our own company's employees** (internal users). Filter candidates to persons who
`worker_of` the selected customer org; never surface internal staff.

**6a — Add contacts from the customer's card.** Entering a customer (org) — in **Partners** (org
drawer) and on the **By-Customer** card — must offer **"Add contact"** → opens the Person New-Contact
form **prefilled with that org as employer** (`worker_of`). Today there's no such action; add it.

**6b — "By Customer" doesn't show the customers seen in Partners.** Root: the By-Customer query
(`contacts-page.tsx:215-218`) fetches only orgs with the explicit **`roleType: 'customer'`** tag, so
orgs that are customers but weren't tagged (e.g. אסדן / טקרו / חדיף) don't appear. **Fix:** source the
By-Customer list from the **same set Partners treats as customers** — an org holding the `customer`
role-tag **OR** assigned as the customer on any project. (And when an org is created/used as a
customer, ensure it carries the `customer` role-tag.) Yulian's existing customers must appear here.

**6c — Clicking a Customer card does nothing.** `CustomerCard` (`contacts-page.tsx:820`) has no click
handler on the card/header. **Fix:** make the card (its header) open that **org's BP drawer** (same
drawer Partners uses), so the customer is inspectable/editable. Keep the per-contact row clicks as they
are (`stopPropagation`).

**6d — "By Project" is empty (FIX, do not drop).** The By-Project view shows no projects and no
project-contacts. **Fix:** group by the projects that have attached participants/contacts and list, per
project, the contacts actually attached to it (the project-scoped set from PR-026 —
`project-partner-roles` incl. the new `customer_contact` role + internal team). Empty-state per project
only when it truly has none.

**DoD:** adding a customer contact offers only that customer's people (no internal staff); you can add
a contact from a customer's card/drawer with the employer prefilled; By-Customer lists the same
customers seen in Partners and clicking a card opens its drawer; By-Project lists projects with their
attached contacts.

---

## Item 7 · Contact fields — cross-check (Claude verifies)
Cross-check the add-contact form against the PR-024 field spec (English required / Hebrew optional,
both for org employees; Job Title managed list no free-text; Role(s) multi-select; Discipline lookup;
Main Role kept). I'll diff the shipped form vs the requirement and report gaps — no CC action until I
confirm which fields are missing.

## Item 9 · General polish
After the above land, a screen-by-screen polish pass (spacing, alignment, empty states, dark-mode
parity) on the touched surfaces. Tracked separately once the functional fixes are verified.

---

## Suggested order
1. `qa3-task-add` (the blocker — separate spec) first.
2. Commit D (Contacts/Customers — highest user pain), then Commit C (small, related).
3. Commit A (project list), Commit B (team picker).
Report each commit's DoD from a **runtime staging check**, pause before merge.
