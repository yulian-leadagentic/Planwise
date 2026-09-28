-- Retirement of the legacy free-text TeamTemplateMember.role column.
-- All readers/writers migrated to projectRoleTypeId in the prior commit
-- (chore(retire-legacy): remove TeamTemplateMember.role from API DTO...).
-- The actual DB table is `team_template_members` (snake_case per Prisma
-- @@map). Idempotent: no-op if the column has already been dropped so a
-- re-run against a partially-migrated DB is safe.
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'team_template_members'
    AND COLUMN_NAME  = 'role'
);
SET @stmt := IF(@col_exists > 0,
  'ALTER TABLE `team_template_members` DROP COLUMN `role`',
  'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
