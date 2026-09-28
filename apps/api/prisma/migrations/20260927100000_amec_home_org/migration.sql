-- People UX M6 (P-03 / P-05, 2026-09-27) — AMEC home-org flag.
--
-- Adds `is_home_org` to `business_partners`. Exactly ONE organization row
-- should ever carry `TRUE`. We do NOT enforce that at the DB level with a
-- partial unique index (MySQL doesn't support partial indexes cleanly);
-- the service layer's write path demotes any prior holder in the same
-- transaction as the new set (see BusinessPartnersService).
--
-- Seed logic:
--   1. Prefer an org named literally "AMEC" (display_name or company_name).
--   2. Otherwise fall back to the seeded "Internal" org, if present —
--      that row represented the home org before M6 (the D1 rule used to
--      match on `displayName === 'Internal'`).
--   3. If NEITHER exists, we leave `is_home_org` = FALSE on every row.
--      The follow-up admin report (`GET /admin/reports/home-org-employees`)
--      will surface the mismatch instead of silently mis-classifying.
--
-- After seeding the flag, we ensure the home org owns the `amec.co.il`
-- corporate domain in `business_partner_domains` — but only if no row
-- exists yet. We never MOVE an existing domain row to a different owner.
-- If `amec.co.il` is already claimed by a DIFFERENT org, the report
-- endpoint (or a future audit) surfaces the collision; this migration
-- takes no destructive action.

-- 1. Column + supporting index.
ALTER TABLE `business_partners`
  ADD COLUMN `is_home_org` BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX `business_partners_is_home_org_idx`
  ON `business_partners` (`is_home_org`);

-- 2. Seed the flag. Two-step so the OR fallback is deterministic:
--    first try "amec", then "internal", stopping at the first match.
UPDATE `business_partners`
  SET `is_home_org` = TRUE
  WHERE `id` = (
    SELECT `id` FROM (
      SELECT `id`
        FROM `business_partners`
       WHERE `partner_type` = 'organization'
         AND `deleted_at` IS NULL
         AND (
           LOWER(`display_name`) = 'amec'
           OR LOWER(`company_name`) = 'amec'
         )
       ORDER BY `id` ASC
       LIMIT 1
    ) AS pick_amec
  );

-- Fallback: if no AMEC row was flagged above, try the legacy "Internal"
-- org. Idempotent — the guard checks that nothing already carries the
-- flag before applying the fallback.
UPDATE `business_partners`
  SET `is_home_org` = TRUE
  WHERE `id` = (
    SELECT `id` FROM (
      SELECT `id`
        FROM `business_partners`
       WHERE `partner_type` = 'organization'
         AND `deleted_at` IS NULL
         AND (
           LOWER(`display_name`) = 'internal'
           OR LOWER(`company_name`) = 'internal'
         )
       ORDER BY `id` ASC
       LIMIT 1
    ) AS pick_internal
  )
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT `id` FROM `business_partners` WHERE `is_home_org` = TRUE LIMIT 1
    ) AS already
  );

-- 3. Ensure the home org owns `amec.co.il`. Skipped entirely when either
--    (a) no home org exists yet, or (b) `amec.co.il` already exists in
--    `business_partner_domains` under any owner (we do not overwrite).
INSERT INTO `business_partner_domains` (`partner_id`, `domain`, `is_personal`)
  SELECT h.`id`, 'amec.co.il', FALSE
    FROM `business_partners` AS h
   WHERE h.`is_home_org` = TRUE
     AND NOT EXISTS (
       SELECT 1 FROM `business_partner_domains` d
        WHERE d.`domain` = 'amec.co.il'
     )
   LIMIT 1;
