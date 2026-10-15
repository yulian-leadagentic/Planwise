-- Migration: hr_phase_a
--
-- HR Module Phase A1 (2026-10-15) — pairs with
-- `docs/bm2/planwise-hr-module-spec.md` §7 + §7.1.
-- Additive + reversible: two new columns on `users` plus four new
-- tables (`hr_settings`, `special_hour_buckets`,
-- `employee_bucket_eligibilities`, `employee_attachments`).
--
-- Design highlights (resolved by Yulian in §7.1):
--   • ONE schema migration for A1; catalog seeding (buckets +
--     HR module/roles) lives in `apps/api/prisma/seed.ts`.
--   • `weeklyRestDays` on User is DEFERRED to Phase C — not here.
--   • `document_file_id` on `employee_bucket_eligibilities` is a
--     plain nullable INT (NO FK). Phase B lands the FK to
--     `employee_attachments` once that table carries the real HR
--     document store.
--   • `BucketCreditMode` enum (REPORTED | AUTO) lands with Phase A
--     so the FE can read + store the flag; the behavior that acts
--     on it ships in Phase B/C.
--
-- Written by hand to match the shadow-DB constraint of every BM2
-- migration. Railway's `prisma migrate deploy` on API boot applies
-- it after Yulian backs up the staging DB and merges the push.

-- 1) User additions ────────────────────────────────────────────────
ALTER TABLE `users`
  ADD COLUMN `employment_type` ENUM('GLOBAL','HOURLY') NULL,
  ADD COLUMN `accounting_employee_number` VARCHAR(50) NULL;

-- 2) hr_settings (singleton; defaults match AMEC's current practice) ─
CREATE TABLE `hr_settings` (
  `id`                            INT NOT NULL AUTO_INCREMENT,
  `short_day_hours_holiday_eve`   DECIMAL(4,2) NOT NULL DEFAULT 5,
  `short_day_hours_chol_hamoed`   DECIMAL(4,2) NOT NULL DEFAULT 5,
  `min_hours_per_day`             DECIMAL(4,2) NOT NULL DEFAULT 5,
  `updated_at`                    DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) special_hour_buckets (A/B/C catalog per §3.6) ──────────────────
CREATE TABLE `special_hour_buckets` (
  `id`                     INT NOT NULL AUTO_INCREMENT,
  `code`                   VARCHAR(64)  NOT NULL,
  `name_he`                VARCHAR(100) NOT NULL,
  `behavior`               ENUM('A','B','C') NOT NULL,
  `unit`                   ENUM('DAY','HOUR') NOT NULL,
  `requires_document`      TINYINT(1) NOT NULL DEFAULT 0,
  `daily_amount`           DECIMAL(4,2) NULL,
  `max_per_year`           DECIMAL(6,2) NULL,
  `min_daily_standard`     DECIMAL(4,2) NULL,
  `default_credit_mode`    ENUM('REPORTED','AUTO') NOT NULL DEFAULT 'REPORTED',
  `active`                 TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`             INT NOT NULL DEFAULT 0,
  `is_system`              TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_special_hour_buckets_code` (`code`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4) employee_bucket_eligibilities ──────────────────────────────────
--    document_file_id is NULLABLE INT with NO FK on purpose — Phase B
--    adds the FK to employee_attachments once that store carries HR
--    documents.
CREATE TABLE `employee_bucket_eligibilities` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `user_id`           INT NOT NULL,
  `bucket_id`         INT NOT NULL,
  `daily_amount`      DECIMAL(4,2) NOT NULL,
  `start_date`        DATE NOT NULL,
  `end_date`          DATE NOT NULL,
  `document_file_id`  INT NULL,
  `credit_mode`       ENUM('REPORTED','AUTO') NULL,
  `active`            TINYINT(1) NOT NULL DEFAULT 1,
  `created_by_id`     INT NOT NULL,
  `created_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ix_elig_user` (`user_id`),
  INDEX `ix_elig_bucket` (`bucket_id`),
  CONSTRAINT `fk_elig_user`      FOREIGN KEY (`user_id`)       REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_elig_bucket`    FOREIGN KEY (`bucket_id`)     REFERENCES `special_hour_buckets` (`id`),
  CONSTRAINT `fk_elig_createdby` FOREIGN KEY (`created_by_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5) employee_attachments ───────────────────────────────────────────
CREATE TABLE `employee_attachments` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `user_id`      INT NOT NULL,
  `file_name`    VARCHAR(255) NOT NULL,
  `file_url`     VARCHAR(500) NOT NULL,
  `file_size`    INT NULL,
  `mime_type`    VARCHAR(100) NULL,
  `uploaded_by`  INT NOT NULL,
  `created_at`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ix_hrattach_user` (`user_id`),
  CONSTRAINT `fk_hrattach_user`     FOREIGN KEY (`user_id`)     REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hrattach_uploader` FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
