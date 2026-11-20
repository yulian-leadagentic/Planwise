-- Permissions round 1 (2026-11-20) — extend the ActivityCategory enum
-- with "security" for audit rows about permission / identity changes
-- (role create/update/delete, role-module grants, user role
-- assignment, user create/delete, password/email/active changes, SSO
-- config). GET /admin/activity-logs hides these rows from non-admins.
-- Additive: existing values keep their order, no data is rewritten.

ALTER TABLE `activity_logs`
  MODIFY COLUMN `category` ENUM(
    'auth',
    'project',
    'task',
    'time',
    'contract',
    'user',
    'system',
    'admin',
    'partner',
    'security'
  ) NOT NULL;
