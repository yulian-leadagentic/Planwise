-- People-model-alignment Phase 4 · Stage 1c (2026-09-28)
--
-- Backfill `User.userType` from the D1 rule (email on a home-org
-- domain → 'employee'; otherwise → 'partner'). Also sync the BP role
-- `employee` so business_partner_roles matches the derived state.
--
-- The rule is now applied by the service layer on every user write
-- (see users.service.ts `deriveUserType` / `syncEmployeeBpRole`).
-- This migration is the ONE-SHOT backfill that establishes the
-- invariant across the existing dataset.
--
-- === GATE ================================================================
-- The migration refuses to run when unexpected off-domain employees
-- appear beyond the four Yulian approved in the §9 review:
--   userId 7   (yulian@leadagentic.net — Yulian's own account)
--   userId 6   (gmail test)
--   userId 138 (gmail test)
--   userId 143 (gmail test)
-- If any OTHER user with userType='employee' has an email that is
-- NOT on `amec.co.il` / `amec.com`, the gate fires. Prisma cannot
-- express top-level SIGNAL / raise cleanly, so we abort by attempting
-- to run a prepared statement that inserts into a table whose name IS
-- the failure message. MySQL then errors with
--   "Table 'STAGE_1C_GATE_FAILED_unexpected_off_domain_employees_halt_migration'
--    doesn't exist"
-- which halts `prisma migrate deploy` and rolls the migration back.

SET @unexpected := (
  SELECT COUNT(*) FROM `users` u
   WHERE u.`deleted_at` IS NULL
     AND u.`user_type` = 'employee'
     AND u.`id` NOT IN (7, 6, 138, 143)
     AND (
       u.`email` IS NULL
       OR (
         u.`email` NOT LIKE '%@amec.co.il'
         AND u.`email` NOT LIKE '%@amec.com'
       )
     )
);

SET @stmt := IF(
  @unexpected = 0,
  'DO 0',
  'INSERT INTO `STAGE_1C_GATE_FAILED_unexpected_off_domain_employees_halt_migration` VALUES (1)'
);

PREPARE gate FROM @stmt;
EXECUTE gate;
DEALLOCATE PREPARE gate;

-- === BACKFILL userType ===================================================
-- Everyone on a home domain becomes 'employee'.
UPDATE `users` u
   SET u.`user_type` = 'employee'
 WHERE u.`email` LIKE '%@amec.co.il'
    OR u.`email` LIKE '%@amec.com';

-- Everyone else (including NULL email) becomes 'partner' — External
-- User in the UI. Access is unaffected (that's driven by Access Role).
UPDATE `users` u
   SET u.`user_type` = 'partner'
 WHERE u.`email` IS NULL
    OR (
      u.`email` NOT LIKE '%@amec.co.il'
      AND u.`email` NOT LIKE '%@amec.com'
    );

-- === SYNC BP ROLE `employee` =============================================
-- Add the `employee` BusinessPartnerRole for every home-domain user's
-- linked BP. Idempotent via ON DUPLICATE KEY UPDATE on the compound
-- unique (business_partner_id, role_type_id).
INSERT INTO `business_partner_roles` (`business_partner_id`, `role_type_id`, `is_primary`, `created_at`)
SELECT u.`business_partner_id`, rt.`id`, 0, NOW()
  FROM `users` u
  JOIN `partner_role_types` rt ON rt.`code` = 'employee'
 WHERE u.`business_partner_id` IS NOT NULL
   AND (u.`email` LIKE '%@amec.co.il' OR u.`email` LIKE '%@amec.com')
ON DUPLICATE KEY UPDATE `role_type_id` = VALUES(`role_type_id`);

-- Remove the `employee` role from every non-home-domain user's linked
-- BP. Only touches BPs whose linked user is off-domain — an org-side BP
-- carrying the `employee` tag by itself (unlikely, but defensively) is
-- left alone.
DELETE bpr FROM `business_partner_roles` bpr
  JOIN `partner_role_types` rt ON rt.`id` = bpr.`role_type_id`
  JOIN `users` u ON u.`business_partner_id` = bpr.`business_partner_id`
 WHERE rt.`code` = 'employee'
   AND (
     u.`email` IS NULL
     OR (
       u.`email` NOT LIKE '%@amec.co.il'
       AND u.`email` NOT LIKE '%@amec.com'
     )
   );
