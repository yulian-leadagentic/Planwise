-- Coarse grouping for partner role types so multiple role codes can share
-- a category (e.g. "smb_customer" and "enterprise_customer" both with
-- category="cst"). Today this is for UI grouping; future relationship
-- rules can constrain by category instead of an exact role code.

ALTER TABLE `partner_role_types`
  ADD COLUMN `category` VARCHAR(20) NULL AFTER `description`;

CREATE INDEX `partner_role_types_category_idx`
  ON `partner_role_types`(`category`);

-- Backfill the seeded system roles so the existing data is sensibly grouped
-- on first paint of the new column.
UPDATE `partner_role_types` SET `category` = 'cst' WHERE `code` = 'customer';
UPDATE `partner_role_types` SET `category` = 'sup' WHERE `code` IN ('supplier', 'subcontractor');
UPDATE `partner_role_types` SET `category` = 'int' WHERE `code` = 'employee';
UPDATE `partner_role_types` SET `category` = 'ext' WHERE `code` IN ('external_contact', 'consultant');
