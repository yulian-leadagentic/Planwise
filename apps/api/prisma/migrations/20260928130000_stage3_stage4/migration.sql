-- People-model-alignment Phase 4 · Stages 3 + 4 (2026-09-28)
--
-- Stage 3 — Contracts point at a BusinessPartner (not a User).
--   Add `Contract.partyId` FK → business_partners.id (nullable, no
--   cascade). For every existing contract, backfill partyId from the
--   partner-User's linked BP where one exists (report shows the set
--   is currently empty). Keeps `partnerId` (→ User) as the legacy
--   column for one release — a follow-up drops it once every reader
--   has moved to `partyId`.
--
-- Stage 4 — TeamTemplateMember gains `projectRoleTypeId`.
--   Add the nullable FK → project_role_types.id. Backfill is a no-op
--   (all 34 existing rows have `role` null / empty), but the ALTER
--   TABLE lands so the FE can start writing it right away.
--
-- Both additive + reversible; nothing is dropped in this migration.

-- ─── Stage 3 · Contract.partyId ─────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'contracts'
     AND column_name = 'party_id'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE `contracts` ADD COLUMN `party_id` INT NULL AFTER `partner_id`',
  'DO 0');
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE table_schema = DATABASE()
     AND table_name = 'contracts'
     AND constraint_name = 'contracts_party_id_fk'
);
SET @stmt := IF(@fk_exists = 0,
  'ALTER TABLE `contracts`
     ADD CONSTRAINT `contracts_party_id_fk`
       FOREIGN KEY (`party_id`)
       REFERENCES `business_partners`(`id`)
       ON DELETE SET NULL
       ON UPDATE CASCADE',
  'DO 0');
PREPARE s2 FROM @stmt; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'contracts'
     AND index_name = 'contracts_party_id_idx'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX `contracts_party_id_idx` ON `contracts`(`party_id`)',
  'DO 0');
PREPARE s3 FROM @stmt; EXECUTE s3; DEALLOCATE PREPARE s3;

-- Backfill: for every contract whose partner-User has a linked BP,
-- copy that BP id onto contracts.party_id. Contracts whose User has
-- no BP are left null (report showed zero such rows on staging, but
-- the WHERE clause defends anyway).
UPDATE `contracts` c
  JOIN `users` u ON u.`id` = c.`partner_id`
   SET c.`party_id` = u.`business_partner_id`
 WHERE c.`party_id` IS NULL
   AND u.`business_partner_id` IS NOT NULL;

-- ─── Stage 4 · TeamTemplateMember.projectRoleTypeId ─────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'team_template_members'
     AND column_name = 'project_role_type_id'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE `team_template_members` ADD COLUMN `project_role_type_id` INT NULL AFTER `role`',
  'DO 0');
PREPARE s4 FROM @stmt; EXECUTE s4; DEALLOCATE PREPARE s4;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE table_schema = DATABASE()
     AND table_name = 'team_template_members'
     AND constraint_name = 'team_template_members_project_role_type_id_fk'
);
SET @stmt := IF(@fk_exists = 0,
  'ALTER TABLE `team_template_members`
     ADD CONSTRAINT `team_template_members_project_role_type_id_fk`
       FOREIGN KEY (`project_role_type_id`)
       REFERENCES `project_role_types`(`id`)
       ON DELETE SET NULL
       ON UPDATE CASCADE',
  'DO 0');
PREPARE s5 FROM @stmt; EXECUTE s5; DEALLOCATE PREPARE s5;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'team_template_members'
     AND index_name = 'team_template_members_project_role_type_id_idx'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX `team_template_members_project_role_type_id_idx` ON `team_template_members`(`project_role_type_id`)',
  'DO 0');
PREPARE s6 FROM @stmt; EXECUTE s6; DEALLOCATE PREPARE s6;
