-- M1 — Foundation tables for the Business Partners rework.
-- Three new catalogs:
--   1. number_ranges    — SAP NRIV-style; one row per (objectCode, rangeName)
--   2. currencies       — ISO-4217, seeded with ILS / USD / EUR
--   3. seniority_levels — user-defined, no seed
--
-- Also seeds two new admin nav modules (Number Ranges, Currencies). The
-- "Seniority Levels" catalog lives as a tab on the existing /templates/types
-- page so it does not need a separate module entry.

-- ── number_ranges ───────────────────────────────────────────────────────────
CREATE TABLE `number_ranges` (
  `id`             INT          NOT NULL AUTO_INCREMENT,
  `object_code`    VARCHAR(50)  NOT NULL,
  `range_name`     VARCHAR(50)  NOT NULL DEFAULT 'default',
  `prefix`         VARCHAR(20)  NOT NULL DEFAULT '',
  `pad_width`      INT          NOT NULL DEFAULT 8,
  `from_number`    BIGINT       NOT NULL DEFAULT 1,
  `to_number`      BIGINT       NOT NULL DEFAULT 99999999,
  `current_number` BIGINT       NOT NULL DEFAULT 0,
  `is_active`      BOOLEAN      NOT NULL DEFAULT TRUE,
  `description`    VARCHAR(255) NULL,
  `created_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `number_ranges_object_range_key` (`object_code`, `range_name`)
);

INSERT INTO `number_ranges`
  (`object_code`,    `range_name`, `prefix`, `pad_width`, `from_number`, `to_number`, `current_number`, `description`,                                       `updated_at`)
VALUES
  ('PARTY_PERSON',   'default',    '',       8,           1,             99999999,    0,                'Codes for individual people (contacts, employees)',  CURRENT_TIMESTAMP(3)),
  ('PARTY_ORG',      'default',    '',       8,           1,             99999999,    0,                'Codes for organizations (customers, suppliers)',     CURRENT_TIMESTAMP(3)),
  ('EMPLOYEE',       'default',    '',       8,           1,             99999999,    0,                'Employee numbers',                                   CURRENT_TIMESTAMP(3));

-- ── currencies ──────────────────────────────────────────────────────────────
CREATE TABLE `currencies` (
  `code`       VARCHAR(3)   NOT NULL,
  `name`       VARCHAR(100) NOT NULL,
  `symbol`     VARCHAR(10)  NULL,
  `decimals`   INT          NOT NULL DEFAULT 2,
  `is_active`  BOOLEAN      NOT NULL DEFAULT TRUE,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL,
  PRIMARY KEY (`code`)
);

INSERT INTO `currencies` (`code`, `name`,                  `symbol`, `decimals`, `sort_order`, `updated_at`) VALUES
  ('ILS', 'Israeli New Shekel',                            '₪',  2,          10,           CURRENT_TIMESTAMP(3)),
  ('USD', 'US Dollar',                                     '$',       2,          20,           CURRENT_TIMESTAMP(3)),
  ('EUR', 'Euro',                                          '€',  2,          30,           CURRENT_TIMESTAMP(3));

-- ── seniority_levels ────────────────────────────────────────────────────────
-- No seed. Each organization defines their own ladder via the admin UI.
CREATE TABLE `seniority_levels` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `code`       VARCHAR(50)  NOT NULL,
  `name`       VARCHAR(100) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  BOOLEAN      NOT NULL DEFAULT TRUE,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `seniority_levels_code_key` (`code`)
);

-- ── Seed admin nav modules for new screens ─────────────────────────────────
INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Number Ranges', '/admin/number-ranges', 'Hash', 97, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;

INSERT IGNORE INTO `modules` (`name`, `route`, `icon`, `sort_order`, `parent_id`, `created_at`, `updated_at`)
SELECT 'Currencies', '/admin/currencies', 'DollarSign', 98, id, NOW(), NOW()
  FROM `modules` WHERE `route` = '/admin' LIMIT 1;
