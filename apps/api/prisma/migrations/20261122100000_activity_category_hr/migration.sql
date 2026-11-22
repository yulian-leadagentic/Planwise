-- Permissions round 3 (2026-11-22) — extend the ActivityCategory enum
-- with "hr" for HR audit rows (absences, attachments, eligibilities,
-- employee HR fields, monthly approve / reopen / lock, HR catalog and
-- settings). These rows are visible only to `hr:read` holders: GET
-- /hr/audit lists them, GET /admin/activity-logs hides them from
-- callers without the grant (department leads, an Admin without hr).
-- Additive: existing values keep their order.

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
    'security',
    'hr'
  ) NOT NULL;

-- HrService wrote every HR audit row under category 'admin' with an
-- `hr.*` action (hr.absence.created, hr.attachment.uploaded, ...).
-- Move them to the new category so they leave the general admin feed.
UPDATE `activity_logs`
  SET `category` = 'hr'
  WHERE `action` LIKE 'hr.%'
    AND `category` <> 'hr';
