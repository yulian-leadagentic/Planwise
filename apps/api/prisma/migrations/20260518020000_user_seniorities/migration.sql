-- Date-effective seniority history per user. Lets the project cost
-- calculation use the seniority that was active when the work was
-- logged, not the user's current seniority — important for accuracy
-- when an employee's level changes mid-project.
--
-- The legacy `users.seniority_level_id` column is kept and synced
-- (always equals the current open-ended row's level) so existing
-- reads keep working unchanged. M-cleanup later can drop the column.

CREATE TABLE `user_seniorities` (
  `id`                 INT          NOT NULL AUTO_INCREMENT,
  `user_id`            INT          NOT NULL,
  `seniority_level_id` INT          NOT NULL,
  `start_date`         DATE         NOT NULL,
  -- NULL = currently active. At most one such row per user is
  -- enforced at the service layer (not via partial unique index —
  -- MySQL doesn't support those).
  `end_date`           DATE         NULL,
  `notes`              TEXT         NULL,
  `created_at`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3)  NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `user_seniorities_user_id_start_date_key` (`user_id`, `start_date`),
  INDEX `user_seniorities_user_id_start_date_idx` (`user_id`, `start_date`),
  INDEX `user_seniorities_user_id_end_date_idx` (`user_id`, `end_date`),

  CONSTRAINT `user_seniorities_user_id_fk`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT `user_seniorities_seniority_level_id_fk`
    FOREIGN KEY (`seniority_level_id`) REFERENCES `seniority_levels`(`id`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Backfill: every user with a current seniority becomes an active
-- (open-ended) history row. start_date prefers employment_date when
-- known, otherwise falls back to the user's created_at (cast to a
-- DATE). This gives the cost calculation a reasonable assumption for
-- past time entries: "this user has been at this level since they
-- joined". Admins can refine the dates via the new UI.
INSERT INTO `user_seniorities`
  (`user_id`, `seniority_level_id`, `start_date`, `end_date`, `notes`, `created_at`, `updated_at`)
SELECT
  u.id,
  u.seniority_level_id,
  COALESCE(u.employment_date, DATE(u.created_at)),
  NULL,
  'Backfilled from users.seniority_level_id on 2026-05-18',
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `users` u
WHERE u.seniority_level_id IS NOT NULL
  AND u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `user_seniorities` us
    WHERE us.user_id = u.id AND us.end_date IS NULL
  );
