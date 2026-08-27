-- Migration: discipline_lookup
--
-- BM 2 QA-2 · Commit 4 · PR-024 (2026-08-27) — new managed lookup table
-- for a contact's "Discipline" (Architecture / MEP / Structural / …).
-- Pairs with `docs/bm2/bm2-qa2-cc-specs.md` Commit 4.
--
-- Discipline is a NEW display/search field on `business_partners`.
-- Distinct from:
--   • Profession / Job Title (`business_partner_professions`) — feeds
--     the project-role AND eligibility filter `requiredProfessionIds`.
--   • Main Role / Role(s) (`main_role_type_id` + `business_partner_roles`)
--     — feeds the eligibility filter `requiredPartnerRoleCode`.
--
-- Discipline is INFORMATIONAL only — never a gate. It captures the
-- high-level branch of engineering the contact belongs to (Architect /
-- Structural / MEP / …), so filters and list views can group by it
-- without conflating it with Profession (many disciplines share the
-- "Engineer" profession) or Role (Customer / Supplier / …).
--
-- Shape mirrors `seniority_levels` — user-managed, empty at seed time;
-- each org fills their own catalog via the /admin/disciplines page.
--
-- Hand-written idempotent SQL (same shadow-DB constraint as earlier
-- BM2 migrations — see docs/bm2/bp-model-refactor.md).

CREATE TABLE IF NOT EXISTS `disciplines` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `code`       VARCHAR(50)   NOT NULL,
  `name`       VARCHAR(100)  NOT NULL,
  -- Optional Hebrew rendering — mirrors User / BusinessPartner where
  -- bilingual pickers already surface names in both languages.
  `name_he`    VARCHAR(100)  NULL,
  `sort_order` INT           NOT NULL DEFAULT 0,
  `is_active`  BOOLEAN       NOT NULL DEFAULT TRUE,
  `created_at` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `disciplines_code_key` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── discipline_id on business_partners ─────────────────────────────
-- Nullable — legacy contacts stay unclassified; the picker's empty
-- option represents "no discipline". SET NULL on delete so deleting a
-- discipline never orphans partners; CASCADE on update carries the id
-- through a renumber.
--
-- Sits AFTER `main_role_type_id` — keeps the "categorization" columns
-- next to each other in the physical row.

-- Add the column only when missing (idempotent for re-run in shadow DB).
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'business_partners'
    AND column_name = 'discipline_id'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE `business_partners` ADD COLUMN `discipline_id` INT NULL AFTER `main_role_type_id`',
  'DO 0');
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;

-- FK to disciplines(id).
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
  WHERE table_schema = DATABASE()
    AND table_name = 'business_partners'
    AND constraint_name = 'business_partners_discipline_id_fk'
);
SET @stmt := IF(@fk_exists = 0,
  'ALTER TABLE `business_partners`
     ADD CONSTRAINT `business_partners_discipline_id_fk`
       FOREIGN KEY (`discipline_id`)
       REFERENCES `disciplines`(`id`)
       ON DELETE SET NULL
       ON UPDATE CASCADE',
  'DO 0');
PREPARE s2 FROM @stmt; EXECUTE s2; DEALLOCATE PREPARE s2;

-- Index for filter queries like `WHERE discipline_id = ?` on the
-- Contacts list.
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'business_partners'
    AND index_name = 'business_partners_discipline_id_idx'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX `business_partners_discipline_id_idx` ON `business_partners`(`discipline_id`)',
  'DO 0');
PREPARE s3 FROM @stmt; EXECUTE s3; DEALLOCATE PREPARE s3;
