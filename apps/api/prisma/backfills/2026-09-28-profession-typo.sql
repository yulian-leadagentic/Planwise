-- Labor Category rename — Phase 2 Commit A (2026-09-28).
--
-- The Admin > Job Titles catalog seeded a row called
-- "Proffesional employee" (extra F). This is the label rendered on
-- the People / Contacts / Admin > Job Titles surfaces. Fix the typo.
--
-- Idempotent: WHERE clause skips rows already renamed.
-- Docker was down when Commit A landed, so this SQL is queued to run
-- against staging when the DB is reachable again.

UPDATE profession
SET name = 'Professional employee'
WHERE name = 'Proffesional employee';
