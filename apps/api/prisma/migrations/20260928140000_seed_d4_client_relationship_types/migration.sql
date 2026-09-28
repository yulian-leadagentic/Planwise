-- Migration: seed_d4_client_relationship_types
--
-- D4 (2026-09-28) — data-only seed of three party↔party relationship types
-- that let a person or org be tied to a customer organization outside the
-- employer axis:
--   • consultant_of         — Consultant of that customer
--   • supplier_of           — Supplier of that customer
--   • pm_supervision_for    — Project management / supervision for that customer
--
-- Pairs with `docs/bm2/d4-client-relationship-types.md` (D4-1).
--
-- No schema change. Rows are additive; the migration is idempotent by
-- `code` (matching the pattern in
-- `20260813100000_bp_phase1_relationships_topoff` and
-- `20260503000000_relationship_validity_and_rules`).
--
-- Pre-flight (verified 2026-09-28 against
-- `apps/api/prisma/migrations/20260427000000_business_partners/migration.sql`
-- L135 and `20260511010000_m3b_party_relationships_and_project_roles/migration.sql`
-- L59): the customer PartnerRoleType.code is exactly 'customer'. sideBTargets
-- below therefore constrains side B to organizations that hold the
-- `customer` role.
--
-- Sort ordering: worker_of is at 1 (see 20260503000000... seed and the
-- 20260813100000 top-off). We slot the three D4 rows at 2, 3, 4 —
-- immediately after worker_of — but only when they don't already exist,
-- so re-running the migration doesn't renumber anything.
--
-- side_a_targets: person OR organization (either kind can be a
--   consultant / supplier / PM firm).
-- side_b_targets: organization with the `customer` role — the client.
--
-- Written by hand (not `prisma migrate dev`) for the same shadow-DB
-- reason documented on the earlier top-off migration.

-- 1) consultant_of
INSERT INTO `partner_relationship_types`
  (`code`, `name`, `description`,
   `side_a_label`, `side_b_label`, `inverse_label`,
   `is_symmetric`, `allows_multiple`,
   `side_a_targets`, `side_b_targets`,
   `sort_order`, `is_system`, `created_at`, `updated_at`)
SELECT
  'consultant_of',
  'Consultant of',
  'Party (person or organization) advises this customer organization.',
  'Consultant',
  'Client',
  'Consultants',
  FALSE,
  TRUE,
  CAST('[{"kind":"organization"},{"kind":"person"}]' AS JSON),
  CAST('[{"kind":"organization","roleCodes":["customer"]}]' AS JSON),
  2,
  TRUE,
  NOW(3),
  NOW(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `partner_relationship_types` WHERE `code` = 'consultant_of'
);

-- 2) supplier_of
INSERT INTO `partner_relationship_types`
  (`code`, `name`, `description`,
   `side_a_label`, `side_b_label`, `inverse_label`,
   `is_symmetric`, `allows_multiple`,
   `side_a_targets`, `side_b_targets`,
   `sort_order`, `is_system`, `created_at`, `updated_at`)
SELECT
  'supplier_of',
  'Supplier of',
  'Party (person or organization) supplies goods or services to this customer organization.',
  'Supplier',
  'Client',
  'Suppliers',
  FALSE,
  TRUE,
  CAST('[{"kind":"organization"},{"kind":"person"}]' AS JSON),
  CAST('[{"kind":"organization","roleCodes":["customer"]}]' AS JSON),
  3,
  TRUE,
  NOW(3),
  NOW(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `partner_relationship_types` WHERE `code` = 'supplier_of'
);

-- 3) pm_supervision_for
INSERT INTO `partner_relationship_types`
  (`code`, `name`, `description`,
   `side_a_label`, `side_b_label`, `inverse_label`,
   `is_symmetric`, `allows_multiple`,
   `side_a_targets`, `side_b_targets`,
   `sort_order`, `is_system`, `created_at`, `updated_at`)
SELECT
  'pm_supervision_for',
  'Project management / supervision for',
  'Party (person or organization) provides project management or supervision for this customer organization.',
  'Project manager / Supervisor',
  'Client',
  'Project management / supervision',
  FALSE,
  TRUE,
  CAST('[{"kind":"organization"},{"kind":"person"}]' AS JSON),
  CAST('[{"kind":"organization","roleCodes":["customer"]}]' AS JSON),
  4,
  TRUE,
  NOW(3),
  NOW(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `partner_relationship_types` WHERE `code` = 'pm_supervision_for'
);
