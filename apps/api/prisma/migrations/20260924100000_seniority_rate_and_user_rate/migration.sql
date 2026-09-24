-- QA3 item 1 (2026-09-24): effective-dated cost rates
--
-- Adds two new tables + backfill so a mid-project rate change applies
-- forward only, not retroactively:
--   • `seniority_rates` — rate history per SeniorityLevel. When a rate
--     changes you close the current row (endDate = effectiveFrom) and
--     insert a new open-ended row.
--   • `user_rates` — per-employee OVERRIDE. When a row covers the
--     entry's date it wins over the level's rate. When absent, the
--     person derives from their level.
--
-- Cost is computed at read time (see `cost-rate-resolver.ts`); no
-- stored-cost recompute job is needed after adding/closing a row.
--
-- Backfill (level layer ONLY): for every SeniorityLevel with a non-null
-- `default_hourly_cost`, seed one open-ended row starting at the
-- Unix epoch — this guarantees existing project costs are unchanged on
-- rollout. `seniority_levels.default_hourly_cost` stays as the
-- rollout-era fallback (readers prefer the rate history when present).
-- No backfill for `user_rates` — default state is "no override".

CREATE TABLE `seniority_rates` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `seniority_level_id`  INT NOT NULL,
  `hourly_cost`         DECIMAL(10, 2) NOT NULL,
  `currency`            VARCHAR(3) NULL,
  `start_date`          DATE NOT NULL,
  `end_date`            DATE NULL,
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `seniority_rates_seniority_level_id_start_date_idx` (`seniority_level_id`, `start_date`),
  INDEX `seniority_rates_seniority_level_id_end_date_idx`   (`seniority_level_id`, `end_date`),
  CONSTRAINT `seniority_rates_seniority_level_id_fkey`
    FOREIGN KEY (`seniority_level_id`) REFERENCES `seniority_levels` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE `user_rates` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `user_id`     INT NOT NULL,
  `hourly_cost` DECIMAL(10, 2) NOT NULL,
  `currency`    VARCHAR(3) NULL,
  `start_date`  DATE NOT NULL,
  `end_date`    DATE NULL,
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `user_rates_user_id_start_date_idx` (`user_id`, `start_date`),
  INDEX `user_rates_user_id_end_date_idx`   (`user_id`, `end_date`),
  CONSTRAINT `user_rates_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

-- Backfill: one open-ended row per level with a non-null current rate.
-- start_date is far-past (1970-01-01) so ALL historical time entries
-- fall inside the range and pick up the same rate that today's engine
-- reads from `default_hourly_cost`. Idempotent: NOT EXISTS guards
-- against a re-run creating duplicate open-ended rows.
INSERT INTO `seniority_rates` (`seniority_level_id`, `hourly_cost`, `currency`, `start_date`, `end_date`)
SELECT
  sl.`id`,
  sl.`default_hourly_cost`,
  sl.`currency`,
  DATE('1970-01-01'),
  NULL
FROM `seniority_levels` sl
WHERE sl.`default_hourly_cost` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `seniority_rates` sr
    WHERE sr.`seniority_level_id` = sl.`id`
      AND sr.`end_date` IS NULL
  );
