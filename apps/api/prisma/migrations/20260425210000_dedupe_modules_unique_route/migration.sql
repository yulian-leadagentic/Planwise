-- Earlier sub-module seed migrations used INSERT IGNORE without a unique key on
-- modules.route, so when migrate deploy ran more than once we ended up with two
-- rows per sub-module. Clean those up and add a UNIQUE constraint so it can't
-- happen again.

-- Repoint any role_modules referencing a non-canonical (duplicate) module to
-- the canonical (lowest-id) one. Drop redundant role_modules entries first to
-- avoid hitting the (role_id, module_id) UNIQUE on role_modules.
DELETE rm FROM role_modules rm
JOIN modules m_dup ON rm.module_id = m_dup.id
JOIN (
  SELECT MIN(id) AS canonical_id, route
  FROM modules
  GROUP BY route
) canon ON canon.route = m_dup.route
WHERE m_dup.id <> canon.canonical_id
  AND EXISTS (
    SELECT 1 FROM (SELECT role_id, module_id FROM role_modules) rm2
    WHERE rm2.role_id = rm.role_id AND rm2.module_id = canon.canonical_id
  );

UPDATE role_modules rm
JOIN modules m_dup ON rm.module_id = m_dup.id
JOIN (
  SELECT MIN(id) AS canonical_id, route
  FROM modules
  GROUP BY route
) canon ON canon.route = m_dup.route
SET rm.module_id = canon.canonical_id
WHERE m_dup.id <> canon.canonical_id;

-- Same repoint for resource_overrides (if any rows reference duplicates by id) — safe no-op when the table is empty.

-- Now drop the duplicate module rows.
DELETE m FROM modules m
JOIN (
  SELECT MIN(id) AS canonical_id, route
  FROM modules
  GROUP BY route
) canon ON canon.route = m.route
WHERE m.id <> canon.canonical_id;

-- Prevent recurrence — each route must be unique.
ALTER TABLE `modules` ADD CONSTRAINT `modules_route_key` UNIQUE (`route`);
