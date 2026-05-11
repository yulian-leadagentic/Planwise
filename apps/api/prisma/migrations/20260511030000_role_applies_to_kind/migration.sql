-- Each partner-role declares which party kind it can attach to. The
-- SidePickerCard uses this to filter the role chip list when a target's
-- kind is picked, so admins stop seeing nonsensical combinations like
-- 'organization + employee' or 'person + supplier'.
--
-- Default = 'any' so existing custom roles stay permissive. Seeded
-- system roles get sensible defaults: employee + external_contact are
-- person-only; supplier + subcontractor are organization-only;
-- customer and consultant stay 'any' (B2C and contracting firms both
-- happen in practice).

ALTER TABLE `partner_role_types`
  ADD COLUMN `applies_to_kind` VARCHAR(20) NOT NULL DEFAULT 'any';

UPDATE `partner_role_types` SET applies_to_kind = 'person'
  WHERE code IN ('employee', 'external_contact');

UPDATE `partner_role_types` SET applies_to_kind = 'organization'
  WHERE code IN ('supplier', 'subcontractor');
