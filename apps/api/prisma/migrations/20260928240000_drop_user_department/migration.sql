-- Retire-User.department Step 3/3 (2026-09-28)
--
-- Free-text `users.department` is superseded by `users.org_unit_id`
-- (Stage 2 migration `20260928120000_stage2_orgunits_and_backfill`
-- backfilled it, and commits 1/3 + 2/3 switched every reader and
-- writer to prefer the OrgUnit relation). This migration drops the
-- legacy column. Idempotent — the shadow-DB pass and a re-run against
-- a DB that no longer has the column are both no-ops.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'users'
    AND COLUMN_NAME  = 'department'
);
SET @stmt := IF(@col_exists > 0,
  'ALTER TABLE `users` DROP COLUMN `department`',
  'SELECT 1');
PREPARE s FROM @stmt;
EXECUTE s;
DEALLOCATE PREPARE s;
