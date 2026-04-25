-- Files management sub-module under Projects.
-- Lets roles be granted project access without file upload/delete rights, or vice versa.

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Files', '/projects/files', 'FileText', 41, id, NOW(), NOW() FROM `modules` WHERE `name` = 'Projects' AND `parent_id` IS NULL LIMIT 1;
