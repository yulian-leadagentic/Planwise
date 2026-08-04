-- Personal task type (Tier D #1) + optional Review step (#2).

-- Task.projectId becomes NULLABLE so personal tasks can exist without
-- a project. Drop the existing FK, alter to NULL, re-add the FK.
ALTER TABLE `tasks` DROP FOREIGN KEY `tasks_project_id_fkey`;
ALTER TABLE `tasks` MODIFY `project_id` INT NULL;
ALTER TABLE `tasks`
  ADD CONSTRAINT `tasks_project_id_fkey`
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Personal-task + review flags on Task.
ALTER TABLE `tasks`
  ADD COLUMN `is_personal` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `requires_review` BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX `tasks_is_personal_idx` ON `tasks`(`is_personal`);

-- Task review events (Tier D #2a).
CREATE TABLE `task_review_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `task_id` INT NOT NULL,
  `actor_id` INT NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `reason` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `task_review_events_task_id_created_at_idx` (`task_id`, `created_at`),
  INDEX `task_review_events_actor_id_created_at_idx` (`actor_id`, `created_at`),
  CONSTRAINT `task_review_events_task_id_fkey`
    FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `task_review_events_actor_id_fkey`
    FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
);
