-- Make tasks.zone_id nullable so tasks can attach directly to a project
-- (no zone) — used for project-level deliverables/tasks that aren't tied
-- to any spatial zone. Existing FK is preserved; on zone delete we now
-- SET NULL instead of CASCADE so the task survives but becomes orphaned
-- under the project root.

-- Drop the existing FK so we can change ON DELETE behavior + nullability.
ALTER TABLE `tasks` DROP FOREIGN KEY `tasks_zone_id_fkey`;

-- Allow null
ALTER TABLE `tasks` MODIFY COLUMN `zone_id` INT NULL;

-- Re-add FK with SET NULL on zone delete.
ALTER TABLE `tasks`
  ADD CONSTRAINT `tasks_zone_id_fkey`
    FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
