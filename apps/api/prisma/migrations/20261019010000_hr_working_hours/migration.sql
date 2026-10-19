-- HR Wave 2 — G2: CalendarDay.workingHours (2026-10-19)
--
-- Yulian-approved per docs/bm2/g2-migration-dry-run.md. The calendar
-- becomes the single source of truth for per-day working hours.
-- HrSettings loses its two short-day globals; the HR monthly engine
-- reads `calendar_days.working_hours` directly off the row.
--
-- Order is strict (see §2 of the dry-run doc):
--   A. ADD   `calendar_days.working_hours` (nullable; NULL = use the
--            type default in the engine fallback).
--   B. BACKFILL from the live hr_settings singleton — HOLIDAY_EVE /
--      CHOL_HAMOED pick up admin-configured short-day values;
--      HOLIDAY / REST land at 0. Idempotent (`working_hours IS NULL`
--      guard). HOLIDAY rows that already carried a numeric
--      `half_day_until` string from the pre-G2 FE preserve those
--      hours instead of defaulting to 0.
--   C. DROP   `hr_settings.short_day_hours_holiday_eve` +
--             `hr_settings.short_day_hours_chol_hamoed` — now that
--             the calendar carries the per-row override there are no
--             readers for the two globals.
--
-- NOT dropped on purpose: `calendar_days.half_day_until`. The FE
-- stops reading it in this release; the column survives one release
-- so a rollback is clean (follow-up G2.1 drops it).
--
-- Runs as one transaction on MySQL; Prisma's migrate wraps each
-- migration in a transaction already.

-- A1. Add working_hours on calendar_days (nullable; NULL = use type default)
ALTER TABLE `calendar_days`
  ADD COLUMN `working_hours` DECIMAL(4,2) NULL;

-- B1. Backfill from the hr_settings singleton. HOLIDAY_EVE /
--     CHOL_HAMOED pick up the admin-configured short-day values;
--     HOLIDAY / REST land at 0. Guarded on `working_hours IS NULL`
--     so a re-run is a no-op.
UPDATE `calendar_days` cd
  JOIN `hr_settings` hs
    ON hs.id = (SELECT MIN(id) FROM `hr_settings`)
  SET cd.working_hours = CASE
    WHEN cd.`type` = 'HOLIDAY_EVE'           THEN hs.short_day_hours_holiday_eve
    WHEN cd.`type` = 'CHOL_HAMOED'           THEN hs.short_day_hours_chol_hamoed
    WHEN cd.`type` IN ('HOLIDAY','REST')     THEN 0.00
    ELSE NULL
  END
  WHERE cd.`type` IN ('HOLIDAY_EVE','CHOL_HAMOED','HOLIDAY','REST')
    AND cd.working_hours IS NULL;

-- B2. Preserve HOLIDAY-with-numeric-halfDayUntil admin overrides.
--     The pre-G2 FE stored a numeric hours string (e.g. "4", "4.5")
--     in `half_day_until` for HOLIDAY rows marked as a working day.
--     Without this UPDATE the B1 case above would overwrite those
--     admin-set hours with 0.00. Guard on a REGEXP so a "12:00"
--     clock-time string from older rows is NOT cast — only a
--     plain decimal is adopted. (Dry-run §3 default = migrate.)
UPDATE `calendar_days`
  SET working_hours = CAST(half_day_until AS DECIMAL(4,2))
  WHERE `type` = 'HOLIDAY'
    AND half_day_until IS NOT NULL
    AND half_day_until <> ''
    AND half_day_until REGEXP '^[0-9]+(\\.[0-9]+)?$';

-- C1. Now that calendar_days.working_hours carries the per-row
--     override, the two hr_settings globals have no readers.
ALTER TABLE `hr_settings`
  DROP COLUMN `short_day_hours_holiday_eve`,
  DROP COLUMN `short_day_hours_chol_hamoed`;
