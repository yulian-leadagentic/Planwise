-- QA4 Round-1 · A3 (2026-09-28)
--
-- Per-unit gate: can a project be assigned to this unit?
--
-- Additive, reversible column on `org_units`. Defaults to TRUE so every
-- pre-existing unit stays assignable — admins flip it off in the
-- Organization admin UI (right pane) only when the unit shouldn't host
-- projects (e.g. reference/holding units). The project OrgUnit picker
-- in New-Project / Edit filters to `assignable_to_projects = 1`, and
-- the server (projects.service.ts create/update) rejects assigning a
-- project to a soft-deleted or non-assignable unit.
--
-- Additive + reversible: no drop, no rename. If ever rolled back, the
-- column simply drops with no data loss (the flag is UI-only metadata).

ALTER TABLE `org_units`
  ADD COLUMN `assignable_to_projects` BOOLEAN NOT NULL DEFAULT TRUE;
