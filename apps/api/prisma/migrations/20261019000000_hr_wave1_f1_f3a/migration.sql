-- HR Wave 1 — F1 + F3a (2026-10-19)
--
-- Yulian-approved per docs/bm2/planwise-hr-fixes-wave1.md. One combined
-- migration to reduce deploy churn.
--
-- F1 — `users.daily_standard_hours`:
--   • Backfill the 115 rows where the column is NULL or 0 to the
--     Yulian-approved default 8.40 (3 rows at NULL in count were
--     clarified: 112 NULL + 3 ZERO across the 123 non-soft-deleted
--     users).
--   • Flip the column to NOT NULL with DEFAULT 8.40 so Prisma's
--     `@default(8.40)` lands on INSERT paths that omit the field.
--
-- F3a — `hr_settings.weekly_rest_days`:
--   • Additive JSON column holding an int array (JS Date.getDay()
--     values: 0=Sun…6=Sat). Nullable on purpose so the engine's
--     cold-start fallback (default [5, 6]) stays legal.
--   • Seed the singleton row (id=1) with JSON_ARRAY(5, 6) = [5, 6].
--     Fri + Sat per the Israeli work-week.
--
-- Runs as one transaction on MySQL; Prisma's migrate wraps each
-- migration in a transaction already.

-- 1) F1 — backfill null-or-zero before the ALTER.
UPDATE `users`
  SET `daily_standard_hours` = 8.40
  WHERE `deleted_at` IS NULL
    AND (`daily_standard_hours` IS NULL OR `daily_standard_hours` = 0);

-- 2) F1 — NOT NULL + default. Rows soft-deleted with NULL are
-- also handled: the ALTER forces every row to be non-null, so any
-- stray NULL that slipped past the WHERE above (e.g. a soft-deleted
-- row created pre-F1) still needs a non-null value. We UPDATE those
-- too in a second pass so the ALTER cannot abort on them.
UPDATE `users`
  SET `daily_standard_hours` = 8.40
  WHERE `daily_standard_hours` IS NULL OR `daily_standard_hours` = 0;

ALTER TABLE `users`
  MODIFY COLUMN `daily_standard_hours` DECIMAL(4,2) NOT NULL DEFAULT 8.40;

-- 3) F3a — HrSettings.weeklyRestDays (JSON, nullable).
ALTER TABLE `hr_settings`
  ADD COLUMN `weekly_rest_days` JSON NULL;

-- 4) F3a — seed the singleton row with [5, 6] (Fri + Sat).
UPDATE `hr_settings`
  SET `weekly_rest_days` = JSON_ARRAY(5, 6)
  WHERE `weekly_rest_days` IS NULL;
