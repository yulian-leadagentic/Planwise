-- Seed the navigation-modules tree (top-level + per-card sub-modules).
-- INSERT IGNORE means re-running is a no-op once UNIQUE(route) is enforced
-- by the init migration.

-- ── Top-level modules ───────────────────────────────────────────────────
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`) VALUES
  ('Dashboard',  '/',           'LayoutDashboard', 1, NULL, NOW(), NOW()),
  ('Tasks',      '/tasks',      'CheckSquare',     2, NULL, NOW(), NOW()),
  ('Time',       '/time',       'Clock',           3, NULL, NOW(), NOW()),
  ('Projects',   '/projects',   'FolderKanban',    4, NULL, NOW(), NOW()),
  ('Contracts',  '/contracts',  'FileText',        5, NULL, NOW(), NOW()),
  ('Partners',   '/partners',   'Briefcase',       6, NULL, NOW(), NOW()),
  ('Reports',    '/reports',    'BarChart3',       7, NULL, NOW(), NOW()),
  ('Templates',  '/templates',  'Copy',            8, NULL, NOW(), NOW()),
  ('Admin',      '/admin',      'Settings',        9, NULL, NOW(), NOW());

-- ── Sub-modules under Projects ──────────────────────────────────────────
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Files', '/projects/files', 'FileText', 41, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/projects' LIMIT 1;

-- ── Sub-modules under Templates ─────────────────────────────────────────
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Task Catalog', '/templates/task-catalog', 'BookOpen', 81, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Deliverable Templates', '/templates/deliverables', 'Copy', 82, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Zone Templates', '/templates/zone', 'Layers', 83, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Services', '/templates/services', 'ListChecks', 84, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Types', '/templates/types', 'Tags', 85, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/templates' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Team Templates', '/templates/team', 'Users', 86, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/templates' LIMIT 1;

-- ── Sub-modules under Admin ─────────────────────────────────────────────
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Roles & Permissions', '/admin/roles', 'Shield', 91, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Activity Log', '/admin/activity-log', 'Activity', 92, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Team Clock Dashboard', '/admin/clock-dashboard', 'Clock', 93, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Work Schedules', '/admin/work-schedules', 'Calendar', 94, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Calendar Days', '/admin/calendar', 'Calendar', 95, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Notification Settings', '/admin/notification-settings', 'Bell', 96, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;
