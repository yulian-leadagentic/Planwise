-- G2.1 (2026-10-20) — Deactivate holiday absence types.
-- The calendar's working_hours already reduces the day standard on
-- HOLIDAY / HOLIDAY_EVE / CHOL_HAMOED (0 / 5 / 5 hours). An employee
-- who wants a full day off on an eve day logs regular vacation (חופשה);
-- the engine credits them dayStandard=5 (not 8), so no double-counting.
--
-- Existing AbsenceRecord rows that reference these types are NOT
-- deleted — history is preserved; just no new rows can be created.

UPDATE absence_types
  SET active = 0
  WHERE code IN ('holiday_full', 'holiday_eve_leave', 'chol_hamoed_leave');
