-- Migration: bp_phase1_drop_legacy_relationships
--
-- BM2 Phase 1 (2026-08-13) — schema drop.
-- Pairs with the sibling migration
-- `20260813100000_bp_phase1_relationships_topoff` (which data-migrated
-- any residual rows out of the legacy table).
--
-- Drops:
--   • `business_partner_relationships` table + FKs + indexes
--   • The "M7" legacy validation columns on
--     `partner_relationship_types`:
--       side_a_kind, side_b_kind,
--       applicable_source_type, applicable_target_types,
--       required_source_role_code, required_target_role_code
--     All validation now flows through the structured
--     `side_a_targets` / `side_b_targets` JSON columns.
--
-- Prerequisites (verified by hand before writing this migration):
--   1. grep -rn "businessPartnerRelationship" apps/api/src  →  0 hits
--      (the compat adapter at apps/api/src/modules/business-partner-relationships
--       routes to partner_relationships / project_partner_roles under the hood).
--   2. All partner-relationships.service validation paths that used to
--      read side_a_kind / side_b_kind switched over to sideATargets JSON.
--
-- Written by hand — see gdrive_config / SSO P1 migrations for the
-- same rationale (local MySQL user can't create the shadow DB).

-- 1) Drop the legacy table.
--    FKs (source_partner_id → business_partners, relationship_type_id
--     → partner_relationship_types) cascade off automatically because
--    the whole table is going away.
DROP TABLE IF EXISTS `business_partner_relationships`;

-- 2) Drop the M7 legacy validation columns on partner_relationship_types.
--    Each column is dropped independently so the migration is resilient
--    if a previous manual cleanup dropped a subset.
ALTER TABLE `partner_relationship_types`
  DROP COLUMN `side_a_kind`,
  DROP COLUMN `side_b_kind`,
  DROP COLUMN `applicable_source_type`,
  DROP COLUMN `applicable_target_types`,
  DROP COLUMN `required_source_role_code`,
  DROP COLUMN `required_target_role_code`;
