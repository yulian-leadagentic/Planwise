-- =====================================================
-- HR Phase B · 20261015010000_hr_phase_b
--
-- Pairs with `docs/bm2/planwise-hr-module-spec.md` §3 (CalendarDay +
-- AbsenceType/Record) and §6 (TimeEntry.bucketId + Eligibility.docFK).
--
-- Additive EXCEPT the CalendarDayType enum remap (step 1). Data-safe
-- expand → UPDATE → narrow dance so no row ever carries an illegal
-- enum value. Verified pre-remap row distribution on staging:
--   holiday         13
--   half_day         1
--   company_day_off  0
--   special          0
-- Target post-remap: HOLIDAY 13 · HOLIDAY_EVE 1 · REST 0 · CHOL_HAMOED 0.
--
-- Design decisions (resolved by Yulian, 2026-10-15):
--   • Q1: holiday→HOLIDAY, half_day→HOLIDAY_EVE,
--         company_day_off→REST, special→CHOL_HAMOED.
--   • Q3: REGULAR is a legal enum value but we never materialize
--         REGULAR rows — the time engine defaults missing dates
--         to REGULAR implicitly.
--   • Q5: AbsenceRecord is event-sourced; no balance snapshots.
--   • All new FKs (AbsenceRecord.documentFileId, Eligibility.documentFileId,
--     TimeEntry.specialHourBucketId) use ON DELETE SET NULL so deleting
--     an attachment or bucket catalog row never cascade-nukes historical
--     absence / eligibility / time entries.
--
-- Written by hand to match the shadow-DB constraint of every BM2
-- migration. Railway's `prisma migrate deploy` on API boot applies it
-- after Yulian backs up staging (already done) and merges the push.
-- =====================================================

-- 1) CalendarDayType enum remap ─────────────────────────────────────

-- 1a. Expand ENUM to accept both old + new values so the UPDATE in
--     step 1b doesn't trip MySQL's strict enum-member check.
ALTER TABLE `calendar_days`
  MODIFY COLUMN `type` ENUM(
    'holiday','company_day_off','half_day','special',
    'REGULAR','HOLIDAY','HOLIDAY_EVE','CHOL_HAMOED','REST'
  ) NOT NULL;

-- 1b. Remap existing rows to the new UPPERCASE signature per Q1.
UPDATE `calendar_days` SET `type` = 'HOLIDAY'      WHERE `type` = 'holiday';
UPDATE `calendar_days` SET `type` = 'HOLIDAY_EVE'  WHERE `type` = 'half_day';
UPDATE `calendar_days` SET `type` = 'REST'         WHERE `type` = 'company_day_off';
UPDATE `calendar_days` SET `type` = 'CHOL_HAMOED'  WHERE `type` = 'special';

-- 1c. Narrow ENUM to the final signature (strips the four legacy values).
ALTER TABLE `calendar_days`
  MODIFY COLUMN `type` ENUM('REGULAR','HOLIDAY','HOLIDAY_EVE','CHOL_HAMOED','REST') NOT NULL;

-- 2) absence_types ─────────────────────────────────────────────────
CREATE TABLE `absence_types` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `code`                VARCHAR(64)  NOT NULL,
  `name_he`             VARCHAR(100) NOT NULL,
  `unit`                ENUM('DAY','HOUR') NOT NULL,
  `requires_document`   TINYINT(1) NOT NULL DEFAULT 0,
  `deducts_from_sick`   TINYINT(1) NOT NULL DEFAULT 0,
  `max_per_year`        INT NULL,
  `half_day`            TINYINT(1) NOT NULL DEFAULT 0,
  `active`              TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`          INT NOT NULL DEFAULT 0,
  `is_system`           TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_absence_types_code` (`code`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) absence_records ───────────────────────────────────────────────
--    document_file_id → employee_attachments(id) ON DELETE SET NULL
--    so unlinking an attachment does NOT delete history (Q4 intent).
CREATE TABLE `absence_records` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `user_id`           INT NOT NULL,
  `absence_type_id`   INT NOT NULL,
  `date_from`         DATE NOT NULL,
  `date_to`           DATE NOT NULL,
  `amount`            DECIMAL(5,2) NOT NULL,
  `document_file_id`  INT NULL,
  `note`              VARCHAR(500) NULL,
  `created_by_id`     INT NOT NULL,
  `created_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ix_absence_user_from` (`user_id`,`date_from`),
  INDEX `ix_absence_type` (`absence_type_id`),
  CONSTRAINT `fk_absence_user`      FOREIGN KEY (`user_id`)          REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_absence_type`      FOREIGN KEY (`absence_type_id`)  REFERENCES `absence_types` (`id`),
  CONSTRAINT `fk_absence_createdby` FOREIGN KEY (`created_by_id`)    REFERENCES `users` (`id`),
  CONSTRAINT `fk_absence_doc`       FOREIGN KEY (`document_file_id`) REFERENCES `employee_attachments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4) time_entries — add specialHourBucketId + FK + index ───────────
--    New column is NULLABLE so existing rows stay untouched. The HR
--    engine reads this on behavior-A/B reporting (Phase B3).
ALTER TABLE `time_entries`
  ADD COLUMN `special_hour_bucket_id` INT NULL,
  ADD INDEX  `ix_time_entries_bucket` (`special_hour_bucket_id`),
  ADD CONSTRAINT `fk_time_entries_bucket`
    FOREIGN KEY (`special_hour_bucket_id`) REFERENCES `special_hour_buckets` (`id`) ON DELETE SET NULL;

-- 5) employee_bucket_eligibilities — promote document_file_id to real FK
--    A1 left this as a plain nullable INT with no FK (one-release gap
--    before employee_attachments shipped). B1 closes that gap. SET NULL
--    on attachment delete keeps the eligibility row intact.
ALTER TABLE `employee_bucket_eligibilities`
  ADD CONSTRAINT `fk_elig_doc`
    FOREIGN KEY (`document_file_id`) REFERENCES `employee_attachments` (`id`) ON DELETE SET NULL;
