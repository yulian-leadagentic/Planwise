-- Constrain a relationship type by the role of its TARGET partner. Combined
-- with the existing required_source_role_code, this lets admins express
-- rules like "an external_contact relates only to a customer org": set
-- required_source_role_code='external_contact' AND
-- required_target_role_code='customer'. NULL = no constraint.

ALTER TABLE `partner_relationship_types`
  ADD COLUMN `required_target_role_code` VARCHAR(50) NULL
  AFTER `required_source_role_code`;
