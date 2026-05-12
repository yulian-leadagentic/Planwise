-- Promote PartnerRoleType.category from a free-text column to a proper
-- catalog. The column itself stays a VARCHAR(20) string so existing
-- JSON references (SideTarget.categoryCodes) continue to work — only
-- the back-reference + admin UI changes.

-- Explicit collation matches the existing partner_role_types table
-- (utf8mb4_unicode_ci) so the FK on category->code passes MySQL's
-- "same-collation" requirement. MySQL 8's default would be
-- utf8mb4_0900_ai_ci which mismatches.
CREATE TABLE `partner_role_categories` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `code`        VARCHAR(20)  NOT NULL,
  `name`        VARCHAR(100) NOT NULL,
  `description` VARCHAR(500) NULL,
  `color`       VARCHAR(7)   NULL,
  `sort_order`  INT          NOT NULL DEFAULT 0,
  `is_system`   BOOLEAN      NOT NULL DEFAULT FALSE,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `partner_role_categories_code_key` (`code`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the four categories already in use. Names and colors are
-- defaults — admin can rename / recolour.
INSERT INTO `partner_role_categories`
  (`code`, `name`,           `description`,                                                          `color`,    `sort_order`, `is_system`, `updated_at`)
VALUES
  ('cst', 'Customer-side',  'Customer-facing roles (customer, customer-contact, etc.)',             '#3B82F6', 10, TRUE, CURRENT_TIMESTAMP(3)),
  ('sup', 'Supplier-side',  'Supplier-facing roles (supplier, subcontractor, etc.)',                '#10B981', 20, TRUE, CURRENT_TIMESTAMP(3)),
  ('int', 'Internal',       'Internal-staff roles (employee, contractor)',                           '#8B5CF6', 30, TRUE, CURRENT_TIMESTAMP(3)),
  ('ext', 'External',       'External non-customer/non-supplier roles (consultant, external contact)','#F59E0B', 40, TRUE, CURRENT_TIMESTAMP(3));

-- Any existing role-types with a category value not in the new catalog
-- (free-text drift) get their category cleared. Admin can re-assign
-- from the new picker.
UPDATE `partner_role_types`
  SET `category` = NULL
  WHERE `category` IS NOT NULL
    AND `category` NOT IN (SELECT `code` FROM `partner_role_categories`);

-- Soft FK: role-type.category references partner_role_categories.code.
-- ON DELETE SET NULL = deleting a category unbinds the role-types
-- rather than cascading. ON UPDATE CASCADE = renaming a category code
-- updates all referencing rows.
ALTER TABLE `partner_role_types`
  ADD CONSTRAINT `prt_category_fk`
    FOREIGN KEY (`category`)
    REFERENCES `partner_role_categories`(`code`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
