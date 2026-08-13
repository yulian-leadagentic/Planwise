-- Migration: bp_phase1_relationships_topoff
--
-- BM2 Phase 1 (2026-08-13) — data-migration only.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 1.
--
-- Purpose: top off any residual rows in the legacy
-- `business_partner_relationships` table into the new
-- `partner_relationships` (party↔party) and `project_partner_roles`
-- (project × party × role) tables, then verify `worker_of` has the
-- allowsMultiple flag set. This is the DATA-MIGRATE step; the DROP of
-- the legacy table + M7 columns lives in the sibling migration
-- `20260813100010_bp_phase1_drop_legacy_relationships`.
--
-- The M3b migration (20260511010000) already copied the historical
-- data; this top-off catches any rows that were written to the legacy
-- table AFTER M3b ran (via the still-live BusinessPartnerRelationships
-- POST endpoint or the users.service upsert). `INSERT IGNORE` de-dupes
-- against the same @@unique key M3b established, so re-running is safe.
--
-- Written by hand rather than via `prisma migrate dev` because the
-- local MySQL user (`amec`) lacks CREATE DATABASE / DROP DATABASE for
-- the shadow-DB step — same constraint documented on the SSO P1 and
-- gdrive_config migrations. `prisma migrate deploy` applies verbatim.

-- 1) Org-targeted legacy rows → partner_relationships.
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
JOIN `business_partners` a ON a.id = bpr.source_partner_id
JOIN `business_partners` b ON b.id = bpr.target_id
WHERE bpr.target_type = 'organization'
  AND a.deleted_at IS NULL
  AND b.deleted_at IS NULL;

-- 2) Project-targeted legacy rows → project_partner_roles.
--    Same code→code mapping as the M3b migration.
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
JOIN `projects` p ON p.id = bpr.target_id AND p.deleted_at IS NULL
WHERE bpr.target_type = 'project';

-- 3) worker_of.allows_multiple = TRUE (idempotent).
--    This is the invariant that lets a person hold two active
--    employer edges at once (freelancer / multi-employer). Without it,
--    partner-relationships.service#create soft-ends the earlier edge
--    (see the allowsMultiple branch); with it, both survive and the
--    per-project truth is pinned via ProjectPartnerRole.onBehalfOfPartyId
--    (added in Phase 2).
UPDATE `partner_relationship_types`
   SET `allows_multiple` = TRUE
 WHERE `code` = 'worker_of';

-- 4) Ensure worker_of exists at all (idempotent seed — matches the
--    seed done in 20260503000000_relationship_validity_and_rules).
INSERT INTO `partner_relationship_types`
  (`code`, `name`, `description`, `sort_order`, `is_system`, `allows_multiple`, `created_at`, `updated_at`)
SELECT
  'worker_of',
  'Worker of',
  'Person works for this organization (employer, contact, supplier worker — uniform).',
  1,
  TRUE,
  TRUE,
  NOW(3),
  NOW(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `partner_relationship_types` WHERE `code` = 'worker_of'
);
