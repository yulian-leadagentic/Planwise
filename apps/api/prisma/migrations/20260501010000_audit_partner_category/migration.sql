-- Extend the ActivityCategory enum with a "partner" value so audit log
-- writes from the Business Partners / Partner Types modules can be
-- filtered separately in the activity-log UI.

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
    'partner'
  ) NOT NULL;
