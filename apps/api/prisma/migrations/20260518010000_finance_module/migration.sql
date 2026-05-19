-- Finance permission module. Gates visibility of budget + cost data
-- across the app: project list cost/budget columns, project Cost tab,
-- planning-grid Actual ₪ column, Timesheet Report cost column, and
-- the cost-specific report endpoints.
--
-- Modeled as a non-navigation module: it has a unique `route` (the
-- `modules.route` column is UNIQUE so we need something), but the
-- frontend treats anything without a nav entry as an invisible
-- permission key. Admins grant `canRead` on Finance to roles that
-- should see the financials.
--
-- Idempotent — re-runs are no-ops thanks to the NOT EXISTS guards.

-- 1. Insert the module row if missing.
INSERT INTO modules (name, route, icon, sort_order, parent_id, created_at, updated_at)
SELECT 'Finance', 'finance', 'DollarSign', 0, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1 FROM modules WHERE route = 'finance' OR name = 'Finance'
);

-- 2. Grant the Admin role full perms on Finance so admins keep their
--    end-to-end view. Other roles start with no Finance access by
--    default; admins toggle it on per role via /admin/roles.
INSERT INTO role_modules (role_id, module_id, can_read, can_write, can_delete, can_approve, can_export)
SELECT
  (SELECT id FROM roles WHERE name = 'Admin' LIMIT 1),
  (SELECT id FROM modules WHERE route = 'finance' OR name = 'Finance' LIMIT 1),
  TRUE, TRUE, TRUE, FALSE, FALSE
WHERE EXISTS (SELECT 1 FROM roles WHERE name = 'Admin')
  AND EXISTS (SELECT 1 FROM modules WHERE route = 'finance' OR name = 'Finance')
  AND NOT EXISTS (
    SELECT 1 FROM role_modules
    WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin' LIMIT 1)
      AND module_id = (SELECT id FROM modules WHERE route = 'finance' OR name = 'Finance' LIMIT 1)
  );
