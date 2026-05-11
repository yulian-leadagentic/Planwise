-- M3b — Split BusinessPartnerRelationship into two cleaner tables and
-- migrate the data in-place. The legacy table stays in the schema until M7
-- so the old API surface keeps working during cut-over.
--
--   targetType='organization' rows  →  partner_relationships    (party A ↔ party B)
--   targetType='project'      rows  →  project_partner_roles    (project × party × role)
--   targetType='department'   rows  →  left in legacy (dropped in M7)
--   targetType='team'         rows  →  left in legacy (dropped in M7)
--
-- Also seeds the new project_role_types catalog with six common roles
-- (Customer, Supplier, Participant, Architect, Engineer, Inspector). The
-- first three map 1:1 from the existing project-targeted relationship
-- types so the data migration has a clean join target.

-- ── partner_relationships (BUT050-style party↔party) ─────────────────────────
CREATE TABLE `partner_relationships` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `party_a_id` INT          NOT NULL,
  `party_b_id` INT          NOT NULL,
  `type_id`    INT          NOT NULL,
  `is_primary` BOOLEAN      NOT NULL DEFAULT FALSE,
  `title_at_b` VARCHAR(255) NULL,
  `valid_from` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `valid_to`   DATETIME(3)  NOT NULL DEFAULT '9999-12-31 00:00:00',
  `status`     VARCHAR(20)  NOT NULL DEFAULT 'active',
  `notes`      TEXT         NULL,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pr_unique_active` (`party_a_id`, `party_b_id`, `type_id`, `valid_from`),
  INDEX `pr_party_a_idx` (`party_a_id`),
  INDEX `pr_party_b_idx` (`party_b_id`),
  INDEX `pr_type_idx`    (`type_id`),
  CONSTRAINT `pr_party_a_fk` FOREIGN KEY (`party_a_id`) REFERENCES `business_partners`(`id`) ON DELETE CASCADE,
  CONSTRAINT `pr_party_b_fk` FOREIGN KEY (`party_b_id`) REFERENCES `business_partners`(`id`) ON DELETE CASCADE,
  CONSTRAINT `pr_type_fk`    FOREIGN KEY (`type_id`)    REFERENCES `partner_relationship_types`(`id`)
);

-- ── project_role_types (catalog) ─────────────────────────────────────────────
CREATE TABLE `project_role_types` (
  `id`                          INT          NOT NULL AUTO_INCREMENT,
  `code`                        VARCHAR(50)  NOT NULL,
  `name`                        VARCHAR(100) NOT NULL,
  `description`                 VARCHAR(500) NULL,
  `allowed_partner_kind`        VARCHAR(20)  NOT NULL DEFAULT 'any',
  `required_partner_role_code`  VARCHAR(50)  NULL,
  `is_primary_required`         BOOLEAN      NOT NULL DEFAULT FALSE,
  `sort_order`                  INT          NOT NULL DEFAULT 0,
  `is_system`                   BOOLEAN      NOT NULL DEFAULT FALSE,
  `created_at`                  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`                  DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `project_role_types_code_key` (`code`)
);

INSERT INTO `project_role_types`
  (`code`,        `name`,        `description`,                                  `allowed_partner_kind`, `required_partner_role_code`, `is_primary_required`, `sort_order`, `is_system`, `updated_at`)
VALUES
  ('customer',    'Customer',    'Buyer / paying party for the project',         'organization',         'customer',                    TRUE,                  10,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('supplier',    'Supplier',    'Vendor of goods or services on the project',   'organization',         'supplier',                    FALSE,                 20,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('participant', 'Participant', 'Individual team member working on the project','person',               NULL,                          FALSE,                 30,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('architect',   'Architect',   'Design lead on the project',                   'any',                  NULL,                          FALSE,                 40,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('engineer',    'Engineer',    'Engineering discipline lead',                  'any',                  NULL,                          FALSE,                 50,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('inspector',   'Inspector',   'Inspection / oversight on the project',       'any',                  NULL,                          FALSE,                 60,           TRUE,         CURRENT_TIMESTAMP(3));

-- ── project_partner_roles (project × party × role) ───────────────────────────
CREATE TABLE `project_partner_roles` (
  `id`               INT          NOT NULL AUTO_INCREMENT,
  `project_id`       INT          NOT NULL,
  `party_id`         INT          NOT NULL,
  `role_id`          INT          NOT NULL,
  `is_primary`       BOOLEAN      NOT NULL DEFAULT FALSE,
  `title_in_project` VARCHAR(255) NULL,
  `valid_from`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `valid_to`         DATETIME(3)  NOT NULL DEFAULT '9999-12-31 00:00:00',
  `status`           VARCHAR(20)  NOT NULL DEFAULT 'active',
  `notes`            TEXT         NULL,
  `created_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ppr_unique` (`project_id`, `party_id`, `role_id`, `valid_from`),
  INDEX `ppr_project_idx` (`project_id`),
  INDEX `ppr_party_idx`   (`party_id`),
  INDEX `ppr_role_idx`    (`role_id`),
  CONSTRAINT `ppr_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)              ON DELETE CASCADE,
  CONSTRAINT `ppr_party_fk`   FOREIGN KEY (`party_id`)   REFERENCES `business_partners`(`id`)     ON DELETE CASCADE,
  CONSTRAINT `ppr_role_fk`    FOREIGN KEY (`role_id`)    REFERENCES `project_role_types`(`id`)
);

-- ── Data migration (idempotent — UNIQUE keys prevent re-inserts) ────────────

-- 1. Org-targeted rows → partner_relationships
INSERT IGNORE INTO `partner_relationships`
  (party_a_id, party_b_id, type_id, is_primary, title_at_b, valid_from, valid_to, status, notes, created_at, updated_at)
SELECT
  bpr.source_partner_id,
  bpr.target_id,
  bpr.relationship_type_id,
  bpr.is_primary,
  bpr.role_in_context,
  bpr.valid_from,
  bpr.valid_to,
  bpr.status,
  bpr.notes,
  bpr.created_at,
  bpr.updated_at
FROM `business_partner_relationships` bpr
WHERE bpr.target_type = 'organization';

-- 2. Project-targeted rows → project_partner_roles. Map type.code →
--    project_role_types.code (customer_of_project → customer, etc.).
--    Rows with an unmapped type are left in legacy so nothing is lost.
INSERT IGNORE INTO `project_partner_roles`
  (project_id, party_id, role_id, is_primary, title_in_project, valid_from, valid_to, status, notes, created_at, updated_at)
SELECT
  bpr.target_id,
  bpr.source_partner_id,
  prt.id,
  bpr.is_primary,
  bpr.role_in_context,
  bpr.valid_from,
  bpr.valid_to,
  bpr.status,
  bpr.notes,
  bpr.created_at,
  bpr.updated_at
FROM `business_partner_relationships` bpr
JOIN `partner_relationship_types` pt ON pt.id = bpr.relationship_type_id
JOIN `project_role_types` prt ON prt.code = CASE pt.code
  WHEN 'customer_of_project'     THEN 'customer'
  WHEN 'supplier_of_project'     THEN 'supplier'
  WHEN 'participates_in_project' THEN 'participant'
  ELSE NULL
END
WHERE bpr.target_type = 'project';

-- Nav module for the new admin screen (M3c builds the actual page).
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Project Role Types', '/admin/project-role-types', 'Briefcase', 99, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;
