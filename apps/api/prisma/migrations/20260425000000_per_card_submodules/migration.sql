-- Per-card sub-modules for granular RBAC.
-- Each card on the Templates and Admin hub pages becomes its own permission unit.
-- Existing roles with permission on the parent (templates / admin) keep working
-- via parent-fallback in the permission check (see roles.guard.ts and use-permissions.ts).

-- Templates sub-modules
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Task Catalog', '/templates/task-catalog', 'BookOpen', 81, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Deliverable Templates', '/templates/deliverables', 'Copy', 82, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Zone Templates', '/templates/zone', 'Layers', 83, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Services', '/templates/services', 'ListChecks', 84, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Types', '/templates/types', 'Tags', 85, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Team Templates', '/templates/team', 'Users', 86, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Templates' LIMIT 1;

-- Admin sub-modules (People is already a top-level module — keep as-is)
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Roles & Permissions', '/admin/roles', 'Shield', 91, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Activity Log', '/admin/activity-log', 'Activity', 92, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Team Clock Dashboard', '/admin/clock-dashboard', 'Clock', 93, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Work Schedules', '/admin/work-schedules', 'Calendar', 94, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Calendar Days', '/admin/calendar', 'Calendar', 95, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Notification Settings', '/admin/notification-settings', 'Bell', 96, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Admin' LIMIT 1;
