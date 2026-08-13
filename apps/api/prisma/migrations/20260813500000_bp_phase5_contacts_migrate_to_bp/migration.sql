-- Migration: bp_phase5_contacts_migrate_to_bp
--
-- BM2 Phase 5 (2026-08-13) — data-migration only.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 5.
--
-- Copies every non-deleted row from the legacy `contacts` table into
-- `business_partners(partner_type='person')`. If the User the contact
-- was attached to has a linked BusinessPartner (the User's own BP row),
-- a `worker_of` edge in `partner_relationships` is written from the
-- new person BP → that org (best-effort — only when the linked BP is
-- an organization; person→person worker_of doesn't make sense).
--
-- Idempotency: the INSERT uses NOT EXISTS keyed on (email, first_name,
-- last_name) so re-running the migration doesn't duplicate people.
-- The worker_of insert uses INSERT IGNORE against the existing
-- @@unique on partner_relationships.
--
-- Written by hand — same shadow-DB constraint as the earlier
-- BM2 / BM1 migrations.

-- Step 1 — materialize a person BP for each surviving contact row.
--          Split `name` into first / last with SUBSTRING_INDEX.
INSERT INTO `business_partners`
  (partner_type, display_name, first_name, last_name, email, phone, status, source, notes, created_at, updated_at)
SELECT
  'person',
  c.name,
  CASE
    WHEN LOCATE(' ', TRIM(c.name)) = 0 THEN TRIM(c.name)
    ELSE TRIM(SUBSTRING_INDEX(TRIM(c.name), ' ', LENGTH(TRIM(c.name)) - LENGTH(REPLACE(TRIM(c.name), ' ', ''))))
  END,
  CASE
    WHEN LOCATE(' ', TRIM(c.name)) = 0 THEN NULL
    ELSE TRIM(SUBSTRING_INDEX(TRIM(c.name), ' ', -1))
  END,
  c.email,
  c.phone,
  'active',
  'system',
  CONCAT('Migrated from legacy contacts row #', c.id, ' by 20260813500000_bp_phase5_contacts_migrate_to_bp'),
  c.created_at,
  c.updated_at
FROM `contacts` c
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    -- Rough dedup: skip when a person BP with the same name + email
    -- already exists (avoids double-migrating if this ran once).
    SELECT 1 FROM `business_partners` bp
    WHERE bp.partner_type = 'person'
      AND bp.display_name = c.name
      AND (bp.email <=> c.email)
      AND bp.deleted_at IS NULL
  );

-- Step 2 — wire `worker_of` from the new person BP → org, when the
--          contact's owner User has a linked organization BP.
INSERT IGNORE INTO `partner_relationships`
  (party_a_id, party_b_id, type_id, is_primary, title_at_b, valid_from, valid_to, status, notes, created_at, updated_at)
SELECT
  person_bp.id,
  owner_bp.id,
  wo.id,
  FALSE,
  c.role,
  c.created_at,
  '9999-12-31 00:00:00',
  'active',
  CONCAT('Migrated from legacy contacts row #', c.id),
  c.created_at,
  c.updated_at
FROM `contacts` c
JOIN `users` u              ON u.id  = c.partner_id
JOIN `business_partners` owner_bp ON owner_bp.id = u.business_partner_id
                                 AND owner_bp.partner_type = 'organization'
                                 AND owner_bp.deleted_at IS NULL
JOIN `business_partners` person_bp ON person_bp.partner_type = 'person'
                                   AND person_bp.display_name = c.name
                                   AND (person_bp.email <=> c.email)
                                   AND person_bp.deleted_at IS NULL
JOIN `partner_relationship_types` wo ON wo.code = 'worker_of'
WHERE c.deleted_at IS NULL;
