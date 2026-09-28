-- QA4 Round-1 · B1 (2026-09-28) — Template-side deliverable→Service FK.
--
-- Root cause (from qa4-round1.md B1): the zone/combined-template flow
-- froze the Service link as a name string `[SERVICE:<name>]` in
-- `TemplateTask.description` / `TemplateZoneTask.description` — not
-- an FK. Renaming the deliverable changed `templates.name` but left
-- the frozen markers, so project-init's exact-name JOIN couldn't
-- match and the deliverable materialized with NULL FKs (no Service).
--
-- Fix: give both template-task tables a nullable
-- `deliverable_template_id INT` FK to `templates.id` (ON DELETE SET
-- NULL). Backfill one-time from the existing [SERVICE:<name>] marker
-- by exact-name match to `templates.name` (same extraction as the
-- 20260521030000 `tasks.deliverable_template_id` backfill), so
-- existing template rows keep their link across a rename going
-- forward. The pickers (service-picker-modal / root-service-picker-modal)
-- will start writing the FK directly on create, and the resolution
-- paths in zones.service.ts (applyProjectTemplate / applyTaskTemplate)
-- read the FK first and fall back to the marker only for
-- un-backfilled rows.
--
-- Additive + reversible: no column drop, no rename. Backfill guards
-- with `deliverable_template_id IS NULL` so the migration is safe to
-- re-run on the shadow DB.

-- ─── 1. Add nullable FK columns on both template-task tables ────────

ALTER TABLE `template_tasks`
  ADD COLUMN `deliverable_template_id` INT NULL,
  ADD CONSTRAINT `template_tasks_deliverable_template_id_fkey`
    FOREIGN KEY (`deliverable_template_id`) REFERENCES `templates`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `template_zone_tasks`
  ADD COLUMN `deliverable_template_id` INT NULL,
  ADD CONSTRAINT `template_zone_tasks_deliverable_template_id_fkey`
    FOREIGN KEY (`deliverable_template_id`) REFERENCES `templates`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. FK-backing indexes are implicit under InnoDB ───────────────
-- MySQL/InnoDB auto-creates an index on the referencing column when
-- ADD CONSTRAINT ... FOREIGN KEY runs, so we don't need explicit
-- CREATE INDEX lines here. Prisma's `@relation` metadata already
-- reflects this — the generated Prisma migration for a comparable
-- FK ships without a CREATE INDEX either. Keeping the migration
-- portable across MySQL 5.7 / 8.0.

-- ─── 3. One-time backfill from the [SERVICE:<name>] marker ──────────
-- Same extraction as `20260521030000_backfill_task_deliverables`:
-- pull the substring between `[SERVICE:` and the next `]`, TRIM it,
-- exact-name match on `templates.name` (case-sensitive under MySQL
-- utf8mb4_unicode_ci with the default seed — case-insensitive in
-- practice, matching the picker's write). Only touch rows where
-- (a) the FK is still NULL (re-run safety) and (b) the description
-- carries a marker.
--
-- Scope note: the match considers ALL live templates (no type
-- filter). In practice deliverable templates live under
-- `type='task_list'`, but callers may have registered non-task_list
-- deliverables historically; the description marker never carried a
-- type discriminator, so restricting the JOIN here would hide legacy
-- links. project-init still handles the type check on materialization.

UPDATE `template_tasks` tt
JOIN `templates` dt
  ON dt.`deleted_at` IS NULL
  AND dt.`name` = TRIM(SUBSTRING(
        tt.`description`,
        LOCATE('[SERVICE:', tt.`description`) + 9,
        LOCATE(']', tt.`description`, LOCATE('[SERVICE:', tt.`description`))
          - (LOCATE('[SERVICE:', tt.`description`) + 9)
      ))
SET tt.`deliverable_template_id` = dt.`id`
WHERE tt.`deliverable_template_id` IS NULL
  AND tt.`description` LIKE '%[SERVICE:%';

UPDATE `template_zone_tasks` tzt
JOIN `templates` dt
  ON dt.`deleted_at` IS NULL
  AND dt.`name` = TRIM(SUBSTRING(
        tzt.`description`,
        LOCATE('[SERVICE:', tzt.`description`) + 9,
        LOCATE(']', tzt.`description`, LOCATE('[SERVICE:', tzt.`description`))
          - (LOCATE('[SERVICE:', tzt.`description`) + 9)
      ))
SET tzt.`deliverable_template_id` = dt.`id`
WHERE tzt.`deliverable_template_id` IS NULL
  AND tzt.`description` LIKE '%[SERVICE:%';
