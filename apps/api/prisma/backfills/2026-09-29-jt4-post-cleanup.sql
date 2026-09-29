-- QA4 JT-4 · post-cleanup audit (2026-09-29)
--
-- Applied manually to staging via probe scripts on 2026-09-29 after
-- the `POST /admin/backfills/jobtitle-position-split` endpoint ran.
-- Documented here so prod can reproduce the exact edits when JT-4
-- lands there — the endpoint itself only moves person-links; the
-- gate cleanup + catalog prune below are Yulian-approved decisions
-- that live outside the automated flow because they touch
-- application-configuration (project_role_types.required_profession_ids
-- and the professions catalog itself).
--
-- Prerequisites:
--   • JT-1 migration (20260929200000_positions) applied.
--   • JT-3 seed migration (20260929210000_seed_positions) applied.
--   • JT-4 backfill endpoint invoked and reported
--     `{positionsUpserted:4, personLinksMoved:5, gateRowsRemoved:1,
--       gateRowsKept:3, referencedProfessionIds:[...9 ids]}`.
--   • Full backup of the production DB taken.
--
-- Both blocks below are idempotent — re-running against a
-- cleaned-up DB is a no-op.
--
-- Audit trail on staging (verified):
--   • elc_e (Electrical engineer):
--       BEFORE gate = [7, 1, 2, 3, 4, 5, 6]   (BIM Leader, BIM Coord,
--                                              Domain lead, BIM manager,
--                                              BIM modeler, CEO, HR manager)
--       AFTER  gate = [7, 1, 2, 3, 4]
--   • team_leader (Team Leader):
--       BEFORE gate = [2, 7, 8, 5]            (Domain lead, BIM Leader,
--                                              VP, CEO)
--       AFTER  gate = [2, 7]
--   • professions catalog: 9 → 6 rows (dropped CEO=5, HR manager=6,
--     VP=8). Finance=10 already dropped by JT-4 in the same run
--     (no gate referenced it).

-- ─── PHASE 1 · Gate cleanup ──────────────────────────────────────────
--
-- Removes the org-title profession ids from the two roles that still
-- referenced them post-JT-4. Uses JSON literals so MySQL / MariaDB
-- both accept the payload; the app reads this column as JSON via
-- Prisma. Guarded by the current code (`code = ...`) so the update
-- doesn't hit an unintended row if the id shifted between environments.

UPDATE `project_role_types`
   SET `required_profession_ids` = CAST('[7, 1, 2, 3, 4]' AS JSON)
 WHERE `code` = 'elc_e';

UPDATE `project_role_types`
   SET `required_profession_ids` = CAST('[2, 7]' AS JSON)
 WHERE `code` = 'team_leader';

-- ─── PHASE 2 · Catalog cleanup ───────────────────────────────────────
--
-- Drops the three now-orphaned org-title rows from `professions`.
-- The FK on `business_partner_professions` is CASCADE, and JT-4
-- already deleted every referencing BPP row, so the delete is safe:
--   • No BPP row references these profession ids.
--   • No `project_role_types.required_profession_ids` still contains
--     these ids (phase 1 removed them).
-- If either guard doesn't hold (partial application), MySQL will
-- reject the delete via the FK or the app will silently keep the
-- dead gate value.

DELETE FROM `professions`
 WHERE `id` IN (
   (SELECT `id` FROM (SELECT `id` FROM `professions` WHERE `name` = 'CEO')        AS t1),
   (SELECT `id` FROM (SELECT `id` FROM `professions` WHERE `name` = 'HR manager') AS t2),
   (SELECT `id` FROM (SELECT `id` FROM `professions` WHERE `name` = 'VP')         AS t3)
 );
