-- ────────────────────────────────────────────────────────────────────────
-- BUT050-style time-bounded relationships + sysadmin-configurable rules.
-- ────────────────────────────────────────────────────────────────────────

-- 1) Add rule columns to partner_relationship_types so admins can define
--    new strict rules without code changes.
ALTER TABLE `partner_relationship_types`
  ADD COLUMN `applicable_source_type`     VARCHAR(50) NULL AFTER `applicable_target_types`,
  ADD COLUMN `required_source_role_code`  VARCHAR(50) NULL AFTER `applicable_source_type`;

-- 2) Backfill validity on existing rows so the NOT-NULL change below is safe.
--    valid_from inherits createdAt; valid_to defaults to far-future
--    (open-ended). Existing rows had nullable cols.
UPDATE `business_partner_relationships`
   SET `valid_from` = COALESCE(`valid_from`, `created_at`),
       `valid_to`   = COALESCE(`valid_to`,   '9999-12-31 00:00:00');

-- 3) Tighten validity columns: NOT NULL with sane defaults.
ALTER TABLE `business_partner_relationships`
  MODIFY COLUMN `valid_from` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `valid_to`   DATETIME(3) NOT NULL DEFAULT '9999-12-31 00:00:00';

-- 4) Restructure the seeded relationship types.
--
-- Step A — make sure the four new "primary" types exist (idempotent).
INSERT INTO `partner_relationship_types`
  (`code`, `name`, `description`, `applicable_target_types`, `applicable_source_type`, `required_source_role_code`, `sort_order`, `is_system`, `created_at`, `updated_at`)
VALUES
  ('worker_of',
   'Worker of',
   'Person works for this organization (employer, contact, supplier worker — uniform).',
   'organization', 'person', NULL, 1, TRUE, NOW(3), NOW(3)),
  ('customer_of_project',
   'Customer of project',
   'This organization is the project''s customer. Exactly one per project.',
   'project', 'organization', 'customer', 2, TRUE, NOW(3), NOW(3)),
  ('supplier_of_project',
   'Supplier of project',
   'This organization supplies goods/services to the project.',
   'project', 'organization', 'supplier', 3, TRUE, NOW(3), NOW(3)),
  ('participates_in_project',
   'Participates in project',
   'A specific person works on this project. Use role_in_context to label the role (Project Manager, BIM Manager, etc.).',
   'project', 'person', NULL, 4, TRUE, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `name`                       = VALUES(`name`),
  `description`                = VALUES(`description`),
  `applicable_target_types`    = VALUES(`applicable_target_types`),
  `applicable_source_type`     = VALUES(`applicable_source_type`),
  `required_source_role_code`  = VALUES(`required_source_role_code`),
  `sort_order`                 = VALUES(`sort_order`),
  `is_system`                  = TRUE,
  `updated_at`                 = NOW(3);

-- Step B — fold legacy types into participates_in_project.
-- Each old row gets re-pointed at participates_in_project, and the
-- old type's display name becomes role_in_context (preserves meaning).
UPDATE `business_partner_relationships` bpr
JOIN `partner_relationship_types` old_rt ON old_rt.`id` = bpr.`relationship_type_id`
JOIN `partner_relationship_types` new_rt ON new_rt.`code` = 'participates_in_project'
SET bpr.`relationship_type_id` = new_rt.`id`,
    bpr.`role_in_context`      = COALESCE(NULLIF(bpr.`role_in_context`, ''), old_rt.`name`)
WHERE old_rt.`code` IN (
  'project_member',
  'project_manager',
  'operational_manager',
  'consultant_for',
  'project_stakeholder',
  'contact_person_for'
)
  AND bpr.`target_type` = 'project';

-- Step C — fold employee_of rows into worker_of (just a rename in semantics).
UPDATE `business_partner_relationships` bpr
JOIN `partner_relationship_types` old_rt ON old_rt.`id` = bpr.`relationship_type_id`
JOIN `partner_relationship_types` new_rt ON new_rt.`code` = 'worker_of'
SET bpr.`relationship_type_id` = new_rt.`id`
WHERE old_rt.`code` = 'employee_of';

-- Step D — fold supplier_for / subcontractor_for into supplier_of_project.
UPDATE `business_partner_relationships` bpr
JOIN `partner_relationship_types` old_rt ON old_rt.`id` = bpr.`relationship_type_id`
JOIN `partner_relationship_types` new_rt ON new_rt.`code` = 'supplier_of_project'
SET bpr.`relationship_type_id` = new_rt.`id`
WHERE old_rt.`code` IN ('supplier_for', 'subcontractor_for')
  AND bpr.`target_type` = 'project';

-- Step E — fold any contact_person_for that targets organization into worker_of.
UPDATE `business_partner_relationships` bpr
JOIN `partner_relationship_types` old_rt ON old_rt.`id` = bpr.`relationship_type_id`
JOIN `partner_relationship_types` new_rt ON new_rt.`code` = 'worker_of'
SET bpr.`relationship_type_id` = new_rt.`id`
WHERE old_rt.`code` = 'contact_person_for'
  AND bpr.`target_type` = 'organization';

-- Step F — drop the now-unused legacy types. is_system flag is overridden
-- (these were system once, but they're being retired in this migration).
DELETE FROM `partner_relationship_types`
WHERE `code` IN (
  'project_member',
  'project_manager',
  'operational_manager',
  'consultant_for',
  'project_stakeholder',
  'contact_person_for',
  'employee_of',
  'supplier_for',
  'subcontractor_for'
);

-- 5) Internal-customer organization for projects with no external customer.
--    A regular BP row, marked source=system, name "Internal" — admins can
--    rename it later from the Partners page.
INSERT INTO `business_partners`
  (`partner_type`, `display_name`, `company_name`, `status`, `source`, `notes`, `created_at`, `updated_at`)
SELECT
  'organization',
  'Internal',
  'Internal',
  'active',
  'system',
  'Default customer for internal projects (R&D, internal initiatives). Edit display name to your company name if you prefer.',
  NOW(3), NOW(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `business_partners`
  WHERE `partner_type` = 'organization' AND `company_name` = 'Internal' AND `deleted_at` IS NULL
);

-- Give the Internal org the customer role so it satisfies
-- customer_of_project's required_source_role_code rule.
INSERT IGNORE INTO `business_partner_roles`
  (`business_partner_id`, `role_type_id`, `is_primary`, `created_at`)
SELECT bp.`id`, rt.`id`, TRUE, NOW(3)
FROM `business_partners` bp
JOIN `partner_role_types` rt ON rt.`code` = 'customer'
WHERE bp.`partner_type` = 'organization'
  AND bp.`company_name` = 'Internal'
  AND bp.`deleted_at` IS NULL;
