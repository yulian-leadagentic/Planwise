-- Add a default hourly cost on each seniority level (used by future project
-- labor-cost calculations) and wire a User -> SeniorityLevel FK so every
-- employee has an assigned level.

ALTER TABLE `seniority_levels`
  ADD COLUMN `default_hourly_cost` DECIMAL(10, 2) NULL,
  ADD COLUMN `currency`            VARCHAR(3)     NULL;

ALTER TABLE `users`
  ADD COLUMN `seniority_level_id` INT NULL,
  ADD INDEX `users_seniority_level_idx` (`seniority_level_id`),
  ADD CONSTRAINT `users_seniority_level_fk`
    FOREIGN KEY (`seniority_level_id`)
    REFERENCES `seniority_levels`(`id`)
    ON UPDATE CASCADE
    ON DELETE SET NULL;
