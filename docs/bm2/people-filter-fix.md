# BM2 · People filter fix (spec for CC)

**Context / retest evidence:** on the Projects list ( `/projects` ), the "All Team Members" filter is:
- A native single-select dropdown, unsorted, no type-to-search, requires scrolling
- Backend filter matches sparsely — Alex Isakov shows in 3+ projects unfiltered but selecting his name returns only 2 (same "sparse legacy set" pattern PR-009 hit on the AssigneePicker)

Branch: `fix/people-filter`. Frozen: SSO, PERT, Delivery Planning scheduling.

## (A) Backend — widen the projects memberId filter to a unified person source

Grep `apps/api/src/modules/projects/` for the current `memberId` filter on `GET /projects`. Root cause is likely the same shape as PR-009: it filters on `projectMember.userId` only (or `leaderId` only), missing the party↔party edges that carry BIM Manager / BIM Coordinator / customer contact / other project role holders.

Widen to match a person across ALL of:
- `project.leaderId` (project leader)
- BIM Manager (grep for the project-partner-role code, likely `bim_manager` or similar — verify)
- BIM Coordinator (`bim_coordinator`)
- Legacy `project.members` (ProjectMember rows with `userId`)
- Every `project-partner-role` where `partyId → user.businessPartnerId` OR `contactPartyId → user.businessPartnerId` resolves to the requested user

Reuse the same person-resolution shape as `GET /projects/:id/assignee-candidates` (added in `fix/assignee-source` at `4d6ab38`). If it's practical to extract a shared `resolveProjectPersonUserIds(projectIds)` helper, do so — otherwise duplicate the join logic in the projects list query, but keep them semantically identical.

Accept **`memberIds[]`** as query params (repeatable), semantics = UNION (project matches if ANY of the selected people is on it via ANY of the paths above). Keep `memberId` (single) as an alias for backwards compat (map to `memberIds=[value]`).

**DoD (A):** Filter by Alex Isakov returns every project where he is leader OR BIM Manager OR BIM Coordinator OR a legacy member OR a project-partner-role holder — no "only 2 of 3" gaps.

## (B) Frontend — build one reusable PeopleMultiSelect

New component `apps/web/src/components/shared/people-multi-select.tsx`:
- Type-to-search input (client-side filter over the loaded options)
- Options **alphabetically sorted** by display name
- **Multi-select** with chips inside the trigger for selected people
- Chips have a small × to remove one; a "Clear all" affordance
- Keyboard-accessible: Enter to select highlighted, Backspace on empty input to remove last chip, Arrow keys to navigate, Escape to close
- Design-system compliant: `rounded-[14px]` menu, slate palette, no shadow, `focus-visible:border-blue-500`, `font-mono tabular-nums` for any numeric counts, dark-mode variants
- Reuses whatever combobox / listbox primitive already exists in the app (grep for `Combobox`, `MultiSelectFilter`, `Popover` — do NOT invent yet another primitive; extend the existing `MultiSelectFilter` if that fits, e.g. add avatar rendering)
- Prop shape: `people: { userId: number; displayName: string; avatarUrl?: string | null; subtitle?: string | null }[]`, `value: number[]`, `onChange: (ids: number[]) => void`, `placeholder?`
- Avatar next to each option (small round with initials fallback matching the existing avatar pattern)
- Empty state ("No people match \"foo\"") inside the menu when search yields nothing

**DoD (B):** The component is drop-in usable, keyboard-accessible, sorted, searchable, chip-based.

## (C) Sweep every person selector in the app

Grep for existing person dropdowns and replace with `PeopleMultiSelect`:
- **Projects list "All Team Members"** — `apps/web/src/features/projects/project-list-page.tsx` (or similar) — the surface in the screenshot. Wire to `memberIds[]` on `GET /projects`.
- **Planning modal AssigneePicker** — `apps/web/src/features/projects/planning-modal.tsx` — replace the current custom picker with `PeopleMultiSelect` if the shape fits (people already come from `/assignee-candidates`). If the AssigneePicker has task-specific behavior beyond selection (drag/drop of avatars, quick-toggle), keep the shell and use `PeopleMultiSelect` for the underlying picker only.
- **Team tab filters** — the `apps/web/src/features/projects/project-detail/team-tab.tsx` role-type filter (from `feat/planning-filters`) stays as-is (it's a role-type multi-select, not a people multi-select), but if there's a "filter by person" affordance on that tab, use `PeopleMultiSelect`.
- **Anywhere else a person is selected** — grep `apps/web/src` for `<select>` with a user/member option list, `MemberPicker`, `UserPicker`, etc. Replace them all.

**DoD (C):** Zero bespoke/native person dropdowns remain in `apps/web/src`. Grep proof.

## Overall DoD
- Widened backend memberIds[] filter, Alex Isakov now returns all his projects
- PeopleMultiSelect built once, drop-in
- Every person selector uses it
- No new dialog primitive beyond PeopleMultiSelect itself
- Verify commands green
- Frozen list untouched
