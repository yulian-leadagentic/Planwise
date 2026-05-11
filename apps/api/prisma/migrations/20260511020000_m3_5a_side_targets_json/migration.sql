-- M3.5a — Promote side definitions from {kind, requiredRoleCode} flat
-- columns to a structured JSON array. Each side is now a list of
-- (kind, optional roleCodes[]) tuples so a single relationship type
-- can target multiple kinds at once (e.g. Subcontractor → Project |
-- Customer-Org | Supplier-Org).
--
-- Old sideAKind/sideBKind + required_*_role_code columns stay populated
-- for now (read by the existing service); writes go to the JSON.
-- M7 drops the old columns.

ALTER TABLE `partner_relationship_types`
  ADD COLUMN `side_a_targets` JSON NULL,
  ADD COLUMN `side_b_targets` JSON NULL;

-- ── Backfill: existing rows → JSON shape ────────────────────────────────
-- Side A
UPDATE `partner_relationship_types`
  SET side_a_targets = JSON_ARRAY(JSON_OBJECT(
    'kind', side_a_kind,
    'roleCodes', JSON_ARRAY(required_source_role_code)
  ))
  WHERE side_a_kind IS NOT NULL AND required_source_role_code IS NOT NULL;

UPDATE `partner_relationship_types`
  SET side_a_targets = JSON_ARRAY(JSON_OBJECT('kind', side_a_kind))
  WHERE side_a_kind IS NOT NULL AND required_source_role_code IS NULL;

-- Side B
UPDATE `partner_relationship_types`
  SET side_b_targets = JSON_ARRAY(JSON_OBJECT(
    'kind', side_b_kind,
    'roleCodes', JSON_ARRAY(required_target_role_code)
  ))
  WHERE side_b_kind IS NOT NULL AND required_target_role_code IS NOT NULL;

UPDATE `partner_relationship_types`
  SET side_b_targets = JSON_ARRAY(JSON_OBJECT('kind', side_b_kind))
  WHERE side_b_kind IS NOT NULL AND required_target_role_code IS NULL;
