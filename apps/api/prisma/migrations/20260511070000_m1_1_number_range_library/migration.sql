-- M1.1 — Promote NumberRange from per-object table to a pure sequence
-- library. The link between an object and a range moves to entity_kinds.
--
-- Shape changes on number_ranges:
--   - DROP composite UNIQUE(object_code, range_name)
--   - DROP column range_name
--   - RENAME object_code -> code (still unique)
--   - ADD `name`             (display label, optional)
--   - ADD `mode`             ('auto' | 'manual' | 'external')
--   - ADD `external_pattern` (validation regex for 'external' mode)
--
-- Seed updates:
--   PARTY_PERSON -> PERSON  / prefix PER- / current_number 99 (next: 100)
--   PARTY_ORG    -> ORG     / prefix ORG- / current_number 99
--   EMPLOYEE     -> EMPLOYEE / prefix EMP- / current_number 99
--
-- New entity_kinds table seeded with 5 system entities. Person, Org and
-- Employee bound to their renamed ranges; Project and Contract left
-- unassigned for the admin to wire (drag-and-drop in admin UI later).

-- ── number_ranges restructure ───────────────────────────────────────────────
ALTER TABLE `number_ranges` DROP INDEX `number_ranges_object_range_key`;
ALTER TABLE `number_ranges` DROP COLUMN `range_name`;
ALTER TABLE `number_ranges` RENAME COLUMN `object_code` TO `code`;
ALTER TABLE `number_ranges` ADD UNIQUE INDEX `number_ranges_code_key` (`code`);

ALTER TABLE `number_ranges`
  ADD COLUMN `name`             VARCHAR(100) NULL,
  ADD COLUMN `mode`             VARCHAR(20)  NOT NULL DEFAULT 'auto',
  ADD COLUMN `external_pattern` VARCHAR(255) NULL;

-- Rename existing rows + give them visible defaults so the concept is
-- obvious on first sight (prefix + non-1 starting number).
UPDATE `number_ranges` SET `code` = 'PERSON',   `name` = 'Persons',       `prefix` = 'PER-', `current_number` = 99 WHERE `code` = 'PARTY_PERSON';
UPDATE `number_ranges` SET `code` = 'ORG',      `name` = 'Organizations', `prefix` = 'ORG-', `current_number` = 99 WHERE `code` = 'PARTY_ORG';
UPDATE `number_ranges` SET                       `name` = 'Employees',    `prefix` = 'EMP-', `current_number` = 99 WHERE `code` = 'EMPLOYEE';

-- ── entity_kinds catalog ────────────────────────────────────────────────────
-- Collation matches number_ranges.code (utf8mb4_0900_ai_ci — the MySQL 8
-- default applied when number_ranges was first created in M1). FK requires
-- matching collation on both columns.
CREATE TABLE `entity_kinds` (
  `id`                INT          NOT NULL AUTO_INCREMENT,
  `code`              VARCHAR(50)  NOT NULL,
  `name`              VARCHAR(100) NOT NULL,
  `description`       VARCHAR(500) NULL,
  `number_range_code` VARCHAR(50)  NULL,
  `sort_order`        INT          NOT NULL DEFAULT 0,
  `is_system`         BOOLEAN      NOT NULL DEFAULT FALSE,
  `created_at`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `entity_kinds_code_key` (`code`),
  INDEX `entity_kinds_range_idx` (`number_range_code`),
  CONSTRAINT `entity_kinds_range_fk`
    FOREIGN KEY (`number_range_code`)
    REFERENCES `number_ranges`(`code`)
    ON UPDATE CASCADE
    ON DELETE SET NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO `entity_kinds`
  (`code`,         `name`,          `description`,                                          `number_range_code`, `sort_order`, `is_system`, `updated_at`)
VALUES
  ('PERSON',       'Persons',       'Individuals — contacts, employees, customer contacts', 'PERSON',            10,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('ORGANIZATION', 'Organizations', 'Companies, customers, suppliers',                       'ORG',               20,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('EMPLOYEE',     'Employees',     'Internal staff with system access',                     'EMPLOYEE',          30,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('PROJECT',      'Projects',      'Construction or service projects',                       NULL,                40,           TRUE,         CURRENT_TIMESTAMP(3)),
  ('CONTRACT',     'Contracts',     'Customer / supplier contracts',                          NULL,                50,           TRUE,         CURRENT_TIMESTAMP(3));

-- Nav module for the new admin screen (built in the next commit).
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Object Numbering', '/admin/object-numbering', 'Link', 99, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;
