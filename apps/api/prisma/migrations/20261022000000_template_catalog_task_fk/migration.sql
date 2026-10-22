-- DN-ext · Template catalog task FK (additive, 2026-10-22)
--
-- Mirrors the DN-1/DN-2 fix one level deeper: adds a nullable FK on
-- both `template_tasks` (self-FK) and `template_zone_tasks` back to
-- the SOURCE catalog TemplateTask row (lives under the catalog
-- Template `code='__TASK_CATALOG__'`). Lets the Deliverable
-- Template + Zone Template editors resolve the task's current name
-- + default budget hours/amount LIVE from the catalog, so a rename
-- in Task Catalog reaches every template that referenced it;
-- existing project `Task` rows are NEVER retroactively updated
-- (that is a pull-time snapshot, by Yulian's locked rule).
--
-- `onDelete: SetNull` so deleting a catalog task doesn't cascade
-- -delete the derived rows; they revert to showing the local
-- snapshot columns (`name`, `defaultBudgetHours`,
-- `defaultBudgetAmount`) that stayed in place as safety fallbacks.
--
-- No backfill in SQL — a separate admin endpoint
-- (`POST /admin/backfills/backfill/template-catalog-task-fk`)
-- links historical rows idempotently by `code` match, same dry-run
-- + per-row-transaction pattern DN-1 used.
--
-- Backs docs/bm2/template-name-sync-investigation.md §6 Option A.
--
-- Identifier-length guardrail (MySQL 64-char limit — hit on T1-1):
--   • `template_tasks_catalogTaskId_idx`              → 33 chars ✓
--   • `template_tasks_catalogTaskId_fkey`             → 34 chars ✓
--   • `template_zone_tasks_catalogTaskId_idx`         → 38 chars ✓
--   • `template_zone_tasks_catalogTaskId_fkey`        → 39 chars ✓
--
-- Column naming follows the T1-1 convention (camelCase column name
-- matching the Prisma field; no `@map`), consistent with
-- `template_task_dependencies`.

-- Self-FK on template_tasks: a template task → its source catalog
-- TemplateTask row.
ALTER TABLE `template_tasks`
  ADD COLUMN `catalogTaskId` INT NULL;

CREATE INDEX `template_tasks_catalogTaskId_idx`
  ON `template_tasks` (`catalogTaskId`);

ALTER TABLE `template_tasks`
  ADD CONSTRAINT `template_tasks_catalogTaskId_fkey`
  FOREIGN KEY (`catalogTaskId`) REFERENCES `template_tasks`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Cross-FK on template_zone_tasks: a zone-template task → the
-- source catalog TemplateTask row (lives in the sibling
-- `template_tasks` table under the catalog Template row).
ALTER TABLE `template_zone_tasks`
  ADD COLUMN `catalogTaskId` INT NULL;

CREATE INDEX `template_zone_tasks_catalogTaskId_idx`
  ON `template_zone_tasks` (`catalogTaskId`);

ALTER TABLE `template_zone_tasks`
  ADD CONSTRAINT `template_zone_tasks_catalogTaskId_fkey`
  FOREIGN KEY (`catalogTaskId`) REFERENCES `template_tasks`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
