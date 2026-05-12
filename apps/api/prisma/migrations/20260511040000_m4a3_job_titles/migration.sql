-- M4a.3 — Job Title (renamed from Profession in the UI) as a real
-- classification on persons, plus a multi-select profession constraint
-- on ProjectRoleType.
--
-- The 'professions' table itself isn't renamed (existing API consumers
-- continue to work); only the UI label changes.

-- ── business_partner_professions (Person × Profession join) ─────────────────
CREATE TABLE `business_partner_professions` (
  `id`                   INT          NOT NULL AUTO_INCREMENT,
  `business_partner_id`  INT          NOT NULL,
  `profession_id`        INT          NOT NULL,
  `is_primary`           BOOLEAN      NOT NULL DEFAULT FALSE,
  `since`                DATE         NULL,
  `notes`                VARCHAR(255) NULL,
  `created_at`           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `bpp_unique` (`business_partner_id`, `profession_id`),
  INDEX `bpp_bp_idx` (`business_partner_id`),
  INDEX `bpp_prof_idx` (`profession_id`),
  CONSTRAINT `bpp_bp_fk` FOREIGN KEY (`business_partner_id`) REFERENCES `business_partners`(`id`) ON DELETE CASCADE,
  CONSTRAINT `bpp_prof_fk` FOREIGN KEY (`profession_id`) REFERENCES `professions`(`id`) ON DELETE CASCADE
);

-- ── project_role_types: required_profession_ids JSON ────────────────────────
ALTER TABLE `project_role_types`
  ADD COLUMN `required_profession_ids` JSON NULL;

-- ── Tighten allowed_partner_kind: 'any' is no longer a valid choice. Migrate
--    existing rows to a sensible default ('person' for the seeded
--    architect/engineer/inspector — those are individual roles in practice).
UPDATE `project_role_types`
  SET `allowed_partner_kind` = 'person'
  WHERE `allowed_partner_kind` = 'any';
