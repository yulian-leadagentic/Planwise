-- Add canApprove and canExport permission flags
ALTER TABLE `role_modules` ADD COLUMN `can_approve` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `role_modules` ADD COLUMN `can_export` BOOLEAN NOT NULL DEFAULT false;

-- Add new sub-modules for granular permissions
-- Parent modules already exist from seed (IDs may vary, using INSERT with name lookup)

-- Sub-modules under Projects (assuming Projects parent exists)
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Project Planning', '/projects/planning', 'PenTool', 41, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Projects' LIMIT 1;

-- Sub-modules under Tasks
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Task Approval', '/tasks/approval', 'CheckCircle', 21, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Tasks' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Task Reassignment', '/tasks/reassignment', 'UserPlus', 22, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Tasks' LIMIT 1;

-- Sub-modules under Time
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Time Approval', '/time/approval', 'ClockCheck', 31, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Time' LIMIT 1;

-- Sub-modules under Templates
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Task Templates', '/templates/task', 'FileText', 81, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Zone Templates', '/templates/zone', 'Map', 82, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

-- Sub-modules under People
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Personal Data', '/people/personal', 'UserCircle', 61, id, NOW(), NOW() FROM `modules` WHERE `name` = 'People' LIMIT 1;

-- Sub-modules under Admin
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Calendar', '/admin/calendar', 'Calendar', 91, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Roles', '/admin/roles', 'Shield', 92, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

-- Operations module (top-level, between Dashboard and Projects)
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
VALUES ('Operations', '/operations', 'Activity', 15, NULL, NOW(), NOW());
