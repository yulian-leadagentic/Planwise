-- Migration: positions
--
-- QA4 JT-1 (2026-09-29) — pairs with `docs/bm2/qa4-jobtitle-position-
-- qualification-split.md`. Splits the overloaded `Profession` list into
-- two axes:
--   • Position     — descriptive org title (this table). NEW.
--   • Qualification (`professions`, unchanged) — functional capability
--                    that gates project-role eligibility.
--
-- Additive + reversible:
--   • New `positions` catalog (mirrors `disciplines` shape — code +
--     name + Hebrew + sortOrder + isActive).
--   • New nullable `position_id` on `business_partners`, FK →
--     `positions`, SET NULL on delete so pruning the catalog never
--     orphans a partner. No existing row is touched — every
--     BusinessPartner keeps its full profession set until JT-4's
--     backfill moves the org-position rows off.
--
-- Written by hand (same shadow-DB constraint as the other BM2
-- migrations). No data backfill in this migration — JT-4's admin
-- endpoint runs that separately, after Yulian signs off on the
-- taxonomy split.

CREATE TABLE `positions` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `code`       VARCHAR(50)  NOT NULL,
  `name`       VARCHAR(100) NOT NULL,
  `name_he`    VARCHAR(100)     NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  BOOLEAN      NOT NULL DEFAULT TRUE,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `positions_code_key` (`code`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

ALTER TABLE `business_partners`
  ADD COLUMN `position_id` INT NULL,
  ADD CONSTRAINT `fk_bp_position`
    FOREIGN KEY (`position_id`)
    REFERENCES `positions` (`id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE,
  ADD KEY `bp_position_idx` (`position_id`);
