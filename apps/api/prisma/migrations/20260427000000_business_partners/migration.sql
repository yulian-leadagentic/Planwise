-- DropForeignKey
ALTER TABLE `project_files` DROP FOREIGN KEY `project_files_uploaded_by_fkey`;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `business_partner_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `business_partners` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `partner_type` ENUM('person', 'organization') NOT NULL,
    `display_name` VARCHAR(255) NOT NULL,
    `first_name` VARCHAR(100) NULL,
    `last_name` VARCHAR(100) NULL,
    `company_name` VARCHAR(255) NULL,
    `tax_id` VARCHAR(50) NULL,
    `email` VARCHAR(255) NULL,
    `phone` VARCHAR(50) NULL,
    `mobile` VARCHAR(50) NULL,
    `address` VARCHAR(500) NULL,
    `website` VARCHAR(255) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `source` ENUM('manual', 'import', 'google', 'outlook', 'system') NOT NULL DEFAULT 'manual',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    UNIQUE INDEX `business_partners_email_key`(`email`),
    INDEX `business_partners_partner_type_idx`(`partner_type`),
    INDEX `business_partners_status_idx`(`status`),
    INDEX `business_partners_company_name_idx`(`company_name`),
    INDEX `business_partners_deleted_at_idx`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_role_types` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `partner_role_types_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `partner_relationship_types` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `applicable_target_types` VARCHAR(255) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `partner_relationship_types_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_partner_roles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `business_partner_id` INTEGER NOT NULL,
    `role_type_id` INTEGER NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `valid_from` DATETIME(3) NULL,
    `valid_to` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `business_partner_roles_business_partner_id_idx`(`business_partner_id`),
    INDEX `business_partner_roles_role_type_id_idx`(`role_type_id`),
    UNIQUE INDEX `business_partner_roles_business_partner_id_role_type_id_key`(`business_partner_id`, `role_type_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_partner_relationships` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source_partner_id` INTEGER NOT NULL,
    `target_type` ENUM('project', 'organization', 'department', 'team') NOT NULL,
    `target_id` INTEGER NOT NULL,
    `relationship_type_id` INTEGER NOT NULL,
    `role_in_context` VARCHAR(255) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `valid_from` DATETIME(3) NULL,
    `valid_to` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'active',
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `business_partner_relationships_source_partner_id_idx`(`source_partner_id`),
    INDEX `business_partner_relationships_target_type_target_id_idx`(`target_type`, `target_id`),
    INDEX `business_partner_relationships_relationship_type_id_idx`(`relationship_type_id`),
    UNIQUE INDEX `business_partner_relationships_source_partner_id_target_type_key`(`source_partner_id`, `target_type`, `target_id`, `relationship_type_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `users_business_partner_id_key` ON `users`(`business_partner_id`);

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_business_partner_id_fkey` FOREIGN KEY (`business_partner_id`) REFERENCES `business_partners`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_files` ADD CONSTRAINT `project_files_uploaded_by_fkey` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_partner_roles` ADD CONSTRAINT `business_partner_roles_business_partner_id_fkey` FOREIGN KEY (`business_partner_id`) REFERENCES `business_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_partner_roles` ADD CONSTRAINT `business_partner_roles_role_type_id_fkey` FOREIGN KEY (`role_type_id`) REFERENCES `partner_role_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_partner_relationships` ADD CONSTRAINT `business_partner_relationships_source_partner_id_fkey` FOREIGN KEY (`source_partner_id`) REFERENCES `business_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_partner_relationships` ADD CONSTRAINT `business_partner_relationships_relationship_type_id_fkey` FOREIGN KEY (`relationship_type_id`) REFERENCES `partner_relationship_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: predefined PartnerRoleType rows (isSystem=true, can be edited but
-- not deleted by admins — UI enforces). Codes are stable identifiers.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `partner_role_types` (`code`, `name`, `description`, `sort_order`, `is_system`, `created_at`, `updated_at`) VALUES
  ('employee',         'Employee',         'Internal staff member of the company',                                  1, TRUE, NOW(3), NOW(3)),
  ('customer',         'Customer',         'Client who purchases services or has an active project with us',        2, TRUE, NOW(3), NOW(3)),
  ('supplier',         'Supplier',         'Vendor providing materials, equipment, or recurring services',          3, TRUE, NOW(3), NOW(3)),
  ('consultant',       'Consultant',       'External advisor engaged on a per-project basis',                       4, TRUE, NOW(3), NOW(3)),
  ('external_contact', 'External Contact', 'Third-party stakeholder who is not an employee, customer, or supplier', 5, TRUE, NOW(3), NOW(3)),
  ('subcontractor',    'Subcontractor',    'Contracted firm or individual performing scoped work under our supervision', 6, TRUE, NOW(3), NOW(3));

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: predefined PartnerRelationshipType rows (isSystem=true).
-- applicable_target_types is a CSV restricting where each can be used.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `partner_relationship_types` (`code`, `name`, `description`, `applicable_target_types`, `sort_order`, `is_system`, `created_at`, `updated_at`) VALUES
  ('employee_of',         'Employee of',         'Person works for this organization',                       'organization',           1, TRUE, NOW(3), NOW(3)),
  ('contact_person_for',  'Contact Person',      'Primary point of contact at an organization or project',   'organization,project',   2, TRUE, NOW(3), NOW(3)),
  ('project_stakeholder', 'Project Stakeholder', 'Has an interest in the project outcome but no direct role','project',                3, TRUE, NOW(3), NOW(3)),
  ('project_manager',     'Project Manager',     'Internal PM responsible for project delivery',             'project',                4, TRUE, NOW(3), NOW(3)),
  ('operational_manager', 'Operational Manager', 'Day-to-day operational lead on the client side',           'project',                5, TRUE, NOW(3), NOW(3)),
  ('consultant_for',      'Consultant For',      'Engaged as an external consultant on this engagement',     'project',                6, TRUE, NOW(3), NOW(3)),
  ('supplier_for',        'Supplier For',        'Provides goods or services to this engagement',            'project,organization',   7, TRUE, NOW(3), NOW(3)),
  ('subcontractor_for',   'Subcontractor For',   'Performs scoped work under us on this engagement',         'project,organization',   8, TRUE, NOW(3), NOW(3)),
  ('project_member',      'Project Member',      'Internal team member assigned to the project',             'project',                9, TRUE, NOW(3), NOW(3));

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: existing User rows → BusinessPartner (partner_type=person)
-- Source: 'system' for the seeded admin (admin@amec.com), 'manual' for everyone else.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `business_partners`
  (`partner_type`, `display_name`, `first_name`, `last_name`, `company_name`, `tax_id`, `email`, `phone`, `address`, `website`, `status`, `source`, `created_at`, `updated_at`)
SELECT
  'person',
  TRIM(CONCAT(COALESCE(u.`first_name`,''), ' ', COALESCE(u.`last_name`,''))),
  u.`first_name`,
  u.`last_name`,
  NULLIF(u.`company_name`, ''),
  NULLIF(u.`tax_id`, ''),
  u.`email`,
  u.`phone`,
  u.`address`,
  u.`website`,
  CASE WHEN u.`is_active` THEN 'active' ELSE 'inactive' END,
  CASE WHEN u.`email` = 'admin@amec.com' THEN 'system' ELSE 'manual' END,
  u.`created_at`,
  u.`updated_at`
FROM `users` u
WHERE u.`deleted_at` IS NULL;

-- Wire each User row to its newly-created BP via email match (User.email is unique).
UPDATE `users` u
JOIN `business_partners` bp ON bp.`email` = u.`email` AND bp.`partner_type` = 'person'
SET u.`business_partner_id` = bp.`id`
WHERE u.`deleted_at` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: distinct non-empty company_name values from users → organization BPs
-- One organization BP per unique company_name. No email (orgs typically have many contacts).
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `business_partners` (`partner_type`, `display_name`, `company_name`, `status`, `source`, `created_at`, `updated_at`)
SELECT
  'organization',
  org_names.`company_name`,
  org_names.`company_name`,
  'active',
  'manual',
  NOW(3),
  NOW(3)
FROM (
  SELECT DISTINCT TRIM(`company_name`) AS `company_name`
  FROM `users`
  WHERE `company_name` IS NOT NULL
    AND TRIM(`company_name`) <> ''
    AND `deleted_at` IS NULL
) AS org_names
WHERE NOT EXISTS (
  SELECT 1 FROM `business_partners` bp
  WHERE bp.`partner_type` = 'organization' AND bp.`company_name` = org_names.`company_name`
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: employee_of relationships (person BP → organization BP) for every
-- person whose User.company_name is non-empty.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `business_partner_relationships`
  (`source_partner_id`, `target_type`, `target_id`, `relationship_type_id`, `is_primary`, `status`, `created_at`, `updated_at`)
SELECT
  person_bp.`id`,
  'organization',
  org_bp.`id`,
  rt.`id`,
  TRUE,
  'active',
  NOW(3),
  NOW(3)
FROM `users` u
JOIN `business_partners` person_bp ON person_bp.`id` = u.`business_partner_id`
JOIN `business_partners` org_bp    ON org_bp.`partner_type` = 'organization' AND org_bp.`company_name` = TRIM(u.`company_name`)
JOIN `partner_relationship_types` rt ON rt.`code` = 'employee_of'
WHERE u.`company_name` IS NOT NULL
  AND TRIM(u.`company_name`) <> ''
  AND u.`deleted_at` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: project_member relationships from existing project_members rows.
-- ProjectMember stays as the read source-of-truth during the transition;
-- this just mirrors data into the new model.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `business_partner_relationships`
  (`source_partner_id`, `target_type`, `target_id`, `relationship_type_id`, `role_in_context`, `status`, `created_at`, `updated_at`)
SELECT
  u.`business_partner_id`,
  'project',
  pm.`project_id`,
  rt.`id`,
  pm.`role`,
  'active',
  pm.`created_at`,
  pm.`created_at`
FROM `project_members` pm
JOIN `users` u ON u.`id` = pm.`user_id` AND u.`deleted_at` IS NULL AND u.`business_partner_id` IS NOT NULL
JOIN `partner_relationship_types` rt ON rt.`code` = 'project_member';

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: BusinessPartnerRole rows from User.userType.
--   employee | both -> role_type='employee'
--   partner  | both -> role_type='external_contact'
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `business_partner_roles`
  (`business_partner_id`, `role_type_id`, `is_primary`, `created_at`)
SELECT u.`business_partner_id`, rt.`id`, TRUE, u.`created_at`
FROM `users` u
JOIN `partner_role_types` rt ON rt.`code` = 'employee'
WHERE u.`business_partner_id` IS NOT NULL
  AND u.`deleted_at` IS NULL
  AND u.`user_type` IN ('employee', 'both');

INSERT INTO `business_partner_roles`
  (`business_partner_id`, `role_type_id`, `is_primary`, `created_at`)
SELECT
  u.`business_partner_id`,
  rt.`id`,
  CASE WHEN u.`user_type` = 'partner' THEN TRUE ELSE FALSE END,
  u.`created_at`
FROM `users` u
JOIN `partner_role_types` rt ON rt.`code` = 'external_contact'
WHERE u.`business_partner_id` IS NOT NULL
  AND u.`deleted_at` IS NULL
  AND u.`user_type` IN ('partner', 'both');
