-- Per-zone-per-deliverable target dates + task override flag.
-- (Tier E #10 revision, 2026-08-02.)

ALTER TABLE `tasks`
  ADD COLUMN `due_date_overridden` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `zone_deliverable_targets` (
  `id`                     INT NOT NULL AUTO_INCREMENT,
  `zone_id`                INT NOT NULL,
  `project_deliverable_id` INT NOT NULL,
  `target_date`            DATE NULL,
  `target_months`          INT NULL,
  `created_at`             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`             DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `zone_deliverable_targets_zone_deliverable_unique` (`zone_id`, `project_deliverable_id`),
  INDEX `zone_deliverable_targets_project_deliverable_id_idx` (`project_deliverable_id`),
  CONSTRAINT `zone_deliverable_targets_zone_id_fkey`
    FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `zone_deliverable_targets_project_deliverable_id_fkey`
    FOREIGN KEY (`project_deliverable_id`) REFERENCES `project_deliverables`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);
