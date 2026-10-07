-- Migration: user_preferences + task_typical_ranks
--
-- QA5 Wave 3 (2026-10-07) — paired with `docs/bm2/qa5-ui-fixes-batch.md`
-- items UI-13 and UI-15.
--
-- Two independent, additive tables. Written by hand to match the
-- shadow-DB parity pattern used by the other BM2 migrations.
--
--   1. `user_preferences` — generic per-user key/value JSON store.
--      First consumer: UI-13's `execution-board.column-order`. Cascade
--      on user delete so the row never outlives its owner.
--
--   2. `task_typical_ranks` — cached median relative rank per
--      (deliverable_template, task identity). Populated by
--      `PlanningService.recomputeTaskTypicalRanks()` from dated
--      (`end_date IS NOT NULL`) task occurrences across all projects.
--      Used by UI-15 as a secondary sort key for undated tasks in the
--      Planning tab. NEVER written in a request path.

CREATE TABLE `user_preferences` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `user_id`    INT          NOT NULL,
  `key`        VARCHAR(200) NOT NULL,
  `value`      JSON         NOT NULL,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `user_preferences_user_id_key_key` (`user_id`, `key`),
  KEY `user_preferences_user_id_idx` (`user_id`),

  CONSTRAINT `fk_user_preferences_user`
    FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE `task_typical_ranks` (
  `id`                      INT          NOT NULL AUTO_INCREMENT,
  `deliverable_template_id` INT          NOT NULL,
  `task_identity`           VARCHAR(255) NOT NULL,
  `median_rank`             DOUBLE       NOT NULL,
  `sample_size`             INT          NOT NULL,
  `computed_at`             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `task_typical_ranks_deliverable_template_id_task_identity_key`
    (`deliverable_template_id`, `task_identity`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
