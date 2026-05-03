-- Per-card RBAC sub-module for managing Partner Types from the Admin hub.
-- Roles can be granted independent read / write / delete on this card.

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Partner Types', '/admin/partner-types', 'Tags', 97, id, NOW(3), NOW(3)
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;
