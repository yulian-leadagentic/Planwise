-- Composition multiplicity for zone templates: when a template-zone has
-- instance_count > 1, the apply-template flow creates N zones (each
-- individually renameable) instead of one. Default 1 keeps existing
-- templates' behaviour unchanged.

ALTER TABLE `template_zones`
  ADD COLUMN `instance_count` INT NOT NULL DEFAULT 1 AFTER `typical_count`;
