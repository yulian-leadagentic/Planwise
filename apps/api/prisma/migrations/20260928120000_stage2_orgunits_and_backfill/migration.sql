-- People-model-alignment Phase 4 · Stage 2 (2026-09-28)
--
-- OrgUnit becomes the single source for "department / unit":
--   1. Create 8 new top-level OrgUnits so every value in `User.department`
--      has a corresponding node.
--   2. Backfill `User.orgUnitId` from `User.department` via a case-
--      insensitive trimmed name match.
--   3. Add `Project.orgUnitId` FK (nullable, no cascade) and backfill
--      it from the existing `departmentId` mapping.
--
-- Additive + reversible: no column dropped. `User.department` and
-- `Project.departmentId` stay as legacy caches for one release; a
-- follow-up ticket retires them once every reader is on OrgUnit.
--
-- OrgUnit path invariant (see OrgUnitService): each row's `path`
-- column holds "/" + parent.path + this.id + "/". For a top-level
-- node with parentId=NULL the path is "/{id}/". We insert with a
-- placeholder "/" then UPDATE path once the auto-increment id is known.

-- ─── 2a. Create 8 new OrgUnits ──────────────────────────────────────────
-- INSERT ... SELECT with a NOT EXISTS guard so the migration is a
-- no-op on re-run (shadow DB, hot reboot, staging replay).

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'MEP coordination', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'mep coordination');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'Client managers', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'client managers');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'Management', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'management');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'Development', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'development');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'CAD', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'cad');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'Buildings', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'buildings');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'BIM Consulting', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'bim consulting');

INSERT INTO `org_units` (`name`, `parent_id`, `manager_user_id`, `path`, `depth`, `sort_order`)
SELECT 'Modeling', NULL, NULL, '/', 0, 0
WHERE NOT EXISTS (SELECT 1 FROM `org_units` WHERE LOWER(TRIM(`name`)) = 'modeling');

-- Repair path on every top-level node whose path is still the "/"
-- placeholder — matches every row just inserted plus any older
-- top-level node that shipped without a path (defensive). For a
-- top-level node the correct path is "/{id}/".
UPDATE `org_units`
   SET `path` = CONCAT('/', `id`, '/')
 WHERE `parent_id` IS NULL
   AND `path` = '/';

-- ─── 2b. Backfill User.orgUnitId ────────────────────────────────────────
-- Name → OrgUnit map is applied via a self-join using
-- LOWER(TRIM(...)) so "Design" / " design " / "DESIGN" all resolve to
-- the same node. Two extras beyond the plain name match:
--   • `User.department = 'Infrastructures'` (plural) → maps to the
--     existing Infrastructure unit (id 5) rather than creating a new one.
--   • `User.department = 'Develpment'` (typo)       → maps to the
--     new Development unit above.
-- Users whose department is NULL / empty are left alone; the field
-- was never authoritative for them.

UPDATE `users` u
  JOIN `org_units` ou
    ON LOWER(TRIM(u.`department`)) = LOWER(TRIM(ou.`name`))
   AND ou.`deleted_at` IS NULL
   SET u.`org_unit_id` = ou.`id`
 WHERE u.`department` IS NOT NULL
   AND TRIM(u.`department`) <> ''
   AND u.`org_unit_id` IS NULL;

-- 'Infrastructures' alias → OrgUnit 5 (Infrastructure).
UPDATE `users` u
   SET u.`org_unit_id` = 5
 WHERE LOWER(TRIM(u.`department`)) = 'infrastructures'
   AND u.`org_unit_id` IS NULL;

-- 'Develpment' typo → the newly-inserted Development unit.
UPDATE `users` u
   SET u.`org_unit_id` = (
     SELECT ou.`id` FROM `org_units` ou
      WHERE LOWER(TRIM(ou.`name`)) = 'development'
        AND ou.`deleted_at` IS NULL
      LIMIT 1
   )
 WHERE LOWER(TRIM(u.`department`)) = 'develpment'
   AND u.`org_unit_id` IS NULL;

-- ─── 2c. Add Project.orgUnitId + backfill ────────────────────────────────
-- Nullable + no cascade — matches every other soft-hierarchy link on
-- Project. Idempotent add via information_schema check.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'projects'
     AND column_name = 'org_unit_id'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE `projects` ADD COLUMN `org_unit_id` INT NULL AFTER `department_id`',
  'DO 0');
PREPARE s1 FROM @stmt; EXECUTE s1; DEALLOCATE PREPARE s1;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE table_schema = DATABASE()
     AND table_name = 'projects'
     AND constraint_name = 'projects_org_unit_id_fk'
);
SET @stmt := IF(@fk_exists = 0,
  'ALTER TABLE `projects`
     ADD CONSTRAINT `projects_org_unit_id_fk`
       FOREIGN KEY (`org_unit_id`)
       REFERENCES `org_units`(`id`)
       ON DELETE SET NULL
       ON UPDATE CASCADE',
  'DO 0');
PREPARE s2 FROM @stmt; EXECUTE s2; DEALLOCATE PREPARE s2;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'projects'
     AND index_name = 'projects_org_unit_id_idx'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX `projects_org_unit_id_idx` ON `projects`(`org_unit_id`)',
  'DO 0');
PREPARE s3 FROM @stmt; EXECUTE s3; DEALLOCATE PREPARE s3;

-- Backfill: point every Project with a department_id at the matching
-- OrgUnit via departments.name → org_units.name (case-insensitive).
-- The one project on department_id=3 ('Infrastructures') resolves to
-- OrgUnit 5 (Infrastructure) via the 'infrastructures' alias below.
UPDATE `projects` p
  JOIN `departments` d ON d.`id` = p.`department_id`
  JOIN `org_units` ou
    ON LOWER(TRIM(d.`name`)) = LOWER(TRIM(ou.`name`))
   AND ou.`deleted_at` IS NULL
   SET p.`org_unit_id` = ou.`id`
 WHERE p.`org_unit_id` IS NULL;

-- Alias: 'Infrastructures' department → OrgUnit 5.
UPDATE `projects` p
  JOIN `departments` d ON d.`id` = p.`department_id`
   SET p.`org_unit_id` = 5
 WHERE p.`org_unit_id` IS NULL
   AND LOWER(TRIM(d.`name`)) = 'infrastructures';
