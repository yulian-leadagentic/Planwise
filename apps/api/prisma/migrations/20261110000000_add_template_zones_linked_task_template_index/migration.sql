-- P1 · Reference model backing index (additive, 2026-11-10)
--
-- Adds a btree index on `template_zones.linked_task_template_id` so the
-- new Phase-1 wiring can resolve both halves of the deliverable →
-- template reference in O(log n):
--   • "Used by N templates" on the Deliverable Template detail page
--     (SELECT COUNT(*) FROM template_zones WHERE
--     linked_task_template_id = :id).
--   • Phase-2 migration's grouping scan when it rolls the legacy
--     copied-tasks shape into zone-slots.
--
-- `onDelete` on the FK stays at the Prisma/Postgres default (NoAction
-- for the Prisma field; no explicit ON DELETE on the existing MySQL
-- FK, so it also defaults to RESTRICT). Keeping it that way means a
-- Deliverable Template that's referenced by any zone-slot can't be
-- deleted — the UI surfaces the count as a guard before the user
-- reaches that case.
--
-- Identifier-length guardrail (MySQL 64-char limit):
--   • `template_zones_linked_task_template_id_idx` → 44 chars ✓

CREATE INDEX `template_zones_linked_task_template_id_idx`
  ON `template_zones` (`linked_task_template_id`);
