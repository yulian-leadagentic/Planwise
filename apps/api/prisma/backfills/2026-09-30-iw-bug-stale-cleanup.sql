-- QA4 IW-BUG · stale-row cleanup on staging (2026-09-30)
--
-- Context: Yulian's first-build feedback on the contacts-import wizard
-- (docs/bm2/qa4-import-wizard-SPEC.md §IW-BUG) reported that some
-- committed orgs came back MALFORMED — display_name containing a
-- person in parens (e.g. "אקו הנדסת סביבה ואקוסטיקה (מירי)") and no
-- role type. Analyst read of `commit.service.ts` (post-ORG-1 / RD-3)
-- confirmed the current code CANNOT produce that shape: intra-batch
-- dedupe (ORG-1) creates each distinct org once per batchOrgKey, and
-- `deriveSafeOrgName` (RD-3) rejects the "(person)" suffix and email/
-- dash cells. The malformed rows on staging pre-date those two fixes
-- and are the CC's read of the analyst's diagnosis in the spec.
--
-- Audit trail (2026-09-30, verified via `scratchpad/db-audit`):
--   DataImport 4 = "190039-Contacts.xlsx" @ 2026-09-29 08:23 (BEFORE
--     the RD-3 + ORG-1 series landed on origin/staging). Wrote 13
--     duplicate org BPs of the shape "<firm> - <partner> (<PM>)" with
--     `main_role_type_id = NULL` and no `business_partner_roles` row.
--     Each duplicate carries exactly ONE person via a worker_of edge;
--     the persons have no other employer link (verified below).
--   DataImport 5 = "190040-Contacts.xlsx" @ 2026-09-30 02:34 (AFTER
--     ORG-1/RD-3) produced clean org names but 66 orgs without a
--     `business_partner_roles` row (would render as "not set" in the
--     Organizations tab). IW-2 (default type = Partner) will prevent
--     that shape on future imports; these 66 rows are left alone —
--     the PM can classify them in the Organizations tab.
--
-- Purge target (13 orgs + their 13 orphaned persons):
--   organizations (id):
--     87, 89, 91, 93, 95            — חסון ירושלמי (ליאת)         × 5
--     103, 105, 107, 109, 111       — אקו הנדסת סביבה ואקוסטיקה × 5
--     125, 127, 129                 — אסיף ברמן ... (ענת)          × 3
--
--   persons (id) attached worker_of ONLY those 13 orgs:
--     88, 90, 92, 94, 96            — חסון ירושלמי team
--     104, 106, 108, 110, 112       — אקו הנדסת team
--     126, 128, 130                 — אסיף ברמן team
--
-- The 13 persons currently have exactly ONE worker_of edge each, all
-- to a malformed org (see audit query below). No email of theirs
-- matches a clean-named person BP under a different org, so the
-- persons themselves are stale bad-import artifacts too — the user
-- can re-import 190039 once IW-BUG lands.
--
-- Idempotency: every block is safe to re-run. The `IN (…)` lists are
-- literal ids, but the `deleted_at IS NULL` guard means a second run
-- after the deletes just no-ops. FK cascade drops the worker_of edges
-- when the orgs go.

-- ─── PHASE 0 · Audit reads (RE-RUN BEFORE PURGE TO CONFIRM COUNTS) ────
--
-- Copy the three SELECTs below into a mysql shell and confirm the
-- counts before executing the two DELETE blocks. Numbers on staging
-- 2026-09-30 (from scratchpad/db-audit/audit.mjs + audit2.mjs):
--
--   • malformed orgs: 13
--   • worker_of edges into those orgs: 13
--   • orphan-after-purge persons (single worker_of edge each): 13

SELECT COUNT(*) AS malformed_orgs
  FROM business_partners
 WHERE partner_type = 'organization'
   AND deleted_at IS NULL
   AND source = 'import'
   AND (
     display_name LIKE '%@%'
     OR display_name IN ('-', '—', '–')
     OR display_name IS NULL
     OR display_name = ''
     OR CHAR_LENGTH(display_name) = 1
     OR display_name LIKE '%(%)%'
   );

SELECT COUNT(*) AS worker_of_edges_into_malformed_orgs
  FROM partner_relationships pr
  JOIN partner_relationship_types t ON t.id = pr.type_id AND t.code = 'worker_of'
  JOIN business_partners org ON org.id = pr.party_b_id
 WHERE org.partner_type = 'organization'
   AND org.deleted_at IS NULL
   AND org.source = 'import'
   AND (
     org.display_name LIKE '%@%'
     OR org.display_name IN ('-', '—', '–')
     OR org.display_name IS NULL
     OR org.display_name = ''
     OR CHAR_LENGTH(org.display_name) = 1
     OR org.display_name LIKE '%(%)%'
   );

-- Persons that will be orphaned if the malformed orgs go — i.e. their
-- only worker_of edge points at a malformed org.
SELECT COUNT(*) AS persons_orphaned_by_malformed_org_purge
  FROM business_partners p
 WHERE p.partner_type = 'person'
   AND p.deleted_at IS NULL
   AND p.source = 'import'
   AND EXISTS (
     SELECT 1
       FROM partner_relationships pr
       JOIN business_partners org ON org.id = pr.party_b_id
      WHERE pr.party_a_id = p.id
        AND pr.type_id = (SELECT id FROM partner_relationship_types WHERE code = 'worker_of')
        AND org.partner_type = 'organization'
        AND org.deleted_at IS NULL
        AND org.source = 'import'
        AND (
          org.display_name LIKE '%@%'
          OR org.display_name IN ('-', '—', '–')
          OR org.display_name IS NULL
          OR org.display_name = ''
          OR CHAR_LENGTH(org.display_name) = 1
          OR org.display_name LIKE '%(%)%'
        )
   )
   AND NOT EXISTS (
     -- Person has NO other worker_of edge pointing at a well-formed org
     SELECT 1
       FROM partner_relationships pr2
       JOIN business_partners org2 ON org2.id = pr2.party_b_id
      WHERE pr2.party_a_id = p.id
        AND pr2.type_id = (SELECT id FROM partner_relationship_types WHERE code = 'worker_of')
        AND org2.deleted_at IS NULL
        AND org2.display_name NOT LIKE '%(%)%'
        AND org2.display_name NOT LIKE '%@%'
        AND org2.display_name NOT IN ('-', '—', '–')
        AND org2.display_name IS NOT NULL
        AND CHAR_LENGTH(org2.display_name) > 1
   );

-- ─── PHASE 1 · Delete the 13 malformed org BPs ───────────────────────
--
-- Hard-deletes the org row so the FK cascade drops its
-- partner_relationships (worker_of) rows too. This intentionally
-- forgoes `deleted_at` — a soft-delete would still leave the org in
-- the Organizations list (the query filters by `deletedAt IS NULL`),
-- but a bad row with type 'not set' + a person in the name is not
-- history worth keeping.
--
-- The predicate mirrors PHASE 0's audit read so a fresh run only
-- catches the same malformed shape. `source = 'import'` guards
-- against ever touching a hand-written org.

DELETE FROM business_partners
 WHERE partner_type = 'organization'
   AND deleted_at IS NULL
   AND source = 'import'
   AND (
     display_name LIKE '%@%'
     OR display_name IN ('-', '—', '–')
     OR display_name IS NULL
     OR display_name = ''
     OR CHAR_LENGTH(display_name) = 1
     OR display_name LIKE '%(%)%'
   );

-- ─── PHASE 2 · Delete the now-orphaned import-source persons ─────────
--
-- After PHASE 1 the FK cascade already dropped the worker_of edges;
-- the persons themselves are now genuine orphans. `source = 'import'`
-- + no active worker_of edge is a tight predicate — we never delete
-- a manually-entered contact even if they lost their employer today.
--
-- The subquery reads `partner_relationships` (not the row we just
-- deleted), so PHASE 2 is idempotent: on a re-run the predicate
-- returns zero rows because there are no more import-source orphans.

DELETE FROM business_partners
 WHERE partner_type = 'person'
   AND deleted_at IS NULL
   AND source = 'import'
   AND NOT EXISTS (
     SELECT 1
       FROM partner_relationships pr
      WHERE pr.party_a_id = business_partners.id
        AND pr.type_id = (SELECT id FROM partner_relationship_types WHERE code = 'worker_of')
   );

-- ─── PHASE 3 · Post-purge verification (RUN AFTER THE DELETES) ───────
--
-- Both counts must be zero. If not, some other pre-fix import shape
-- exists — extend the audit query in PHASE 0 to cover it before
-- adding it to the DELETE predicate.

SELECT COUNT(*) AS malformed_orgs_remaining
  FROM business_partners
 WHERE partner_type = 'organization'
   AND deleted_at IS NULL
   AND source = 'import'
   AND (
     display_name LIKE '%@%'
     OR display_name IN ('-', '—', '–')
     OR display_name IS NULL
     OR display_name = ''
     OR CHAR_LENGTH(display_name) = 1
     OR display_name LIKE '%(%)%'
   );

SELECT COUNT(*) AS orphan_import_persons_remaining
  FROM business_partners p
 WHERE p.partner_type = 'person'
   AND p.deleted_at IS NULL
   AND p.source = 'import'
   AND NOT EXISTS (
     SELECT 1
       FROM partner_relationships pr
      WHERE pr.party_a_id = p.id
        AND pr.type_id = (SELECT id FROM partner_relationship_types WHERE code = 'worker_of')
   );
