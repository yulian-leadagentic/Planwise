-- Track the source Deliverable (Template) directly on Task so the
-- planning view's "Group by Deliverable" can label cards by the same
-- name shown on /templates/deliverables (Template.name) instead of via
-- the separate ServiceType catalog. ServiceType + [SERVICE:xxx] are
-- preserved as legacy fallbacks — no data is altered or removed.
--
-- ROLLBACK: see migration.down.sql in this folder. The change is
-- additive (one nullable column with SET NULL on delete); rolling back
-- is a single ALTER TABLE … DROP COLUMN.

ALTER TABLE `tasks`
  ADD COLUMN `deliverable_template_id` INT NULL,
  ADD CONSTRAINT `tasks_deliverable_template_id_fkey`
    FOREIGN KEY (`deliverable_template_id`) REFERENCES `templates`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `tasks_deliverable_template_id_idx`
  ON `tasks` (`deliverable_template_id`);
