-- People-model-alignment Phase 4 · Stage 1a (2026-09-28)
--
-- Seed AMEC corporate domains onto the home org (BP id 4). The M6
-- home-org migration (`20260927100000_amec_home_org`) already set the
-- `is_home_org` flag on the correct row, but the domains table came
-- up empty in the /admin/reports/model-alignment/stage-1-usertype-vs-domain
-- report (`homeDomains: []`) — that is the root cause of the huge Stage 1
-- off-domain-employee list. This migration adds `amec.co.il` and
-- `amec.com` under BP id 4 with `is_personal = false`.
--
-- Guarded against reruns and against another org squatting the domain
-- via the M6 seed (which used a subselect against `is_home_org = TRUE`):
-- the NOT EXISTS on `domain` skips the INSERT when the row is already
-- present under any owner. If a different org owns `amec.co.il` today,
-- this migration silently no-ops on that row — the operator has to
-- resolve the collision manually (report endpoint surfaces it).
--
-- Columns match `business_partner_domains` in `schema.prisma`:
--   partner_id (INT), domain (VARCHAR 255), is_personal (BOOLEAN).
-- The table has no `created_at` column — do not invent one.

INSERT INTO `business_partner_domains` (`partner_id`, `domain`, `is_personal`)
SELECT 4, 'amec.co.il', 0
WHERE NOT EXISTS (
  SELECT 1 FROM `business_partner_domains` WHERE `domain` = 'amec.co.il'
);

INSERT INTO `business_partner_domains` (`partner_id`, `domain`, `is_personal`)
SELECT 4, 'amec.com', 0
WHERE NOT EXISTS (
  SELECT 1 FROM `business_partner_domains` WHERE `domain` = 'amec.com'
);
