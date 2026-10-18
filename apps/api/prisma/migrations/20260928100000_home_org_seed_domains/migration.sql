-- People-model-alignment Phase 4 - Stage 1a (2026-09-28)
--
-- Seed AMEC corporate domains (amec.co.il, amec.com) onto the home org.
-- The home org is resolved by `is_home_org = TRUE` (set by
-- 20260927100000_amec_home_org), NOT by a hard-coded id, so this migration
-- is safe on an empty database: with no home org it is a no-op.
--
-- Guarded against reruns: NOT EXISTS on `domain` skips the INSERT when the
-- row is already present under any owner.
--
-- Columns match `business_partner_domains` in `schema.prisma`:
--   partner_id (INT), domain (VARCHAR 255), is_personal (BOOLEAN).

INSERT INTO `business_partner_domains` (`partner_id`, `domain`, `is_personal`)
SELECT h.`id`, 'amec.co.il', 0
  FROM `business_partners` AS h
 WHERE h.`is_home_org` = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM `business_partner_domains` WHERE `domain` = 'amec.co.il'
   )
 LIMIT 1;

INSERT INTO `business_partner_domains` (`partner_id`, `domain`, `is_personal`)
SELECT h.`id`, 'amec.com', 0
  FROM `business_partners` AS h
 WHERE h.`is_home_org` = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM `business_partner_domains` WHERE `domain` = 'amec.com'
   )
 LIMIT 1;