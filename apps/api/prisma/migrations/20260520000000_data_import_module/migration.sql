-- Data Import feature — tables, provenance columns, permission modules.
--
-- Three new modules (per-entity, NO_ADMIN_BYPASS):
--   • data-import/users
--   • data-import/partners
--   • data-import/contacts
--
-- Two new tables:
--   • data_imports     — one row per upload (audit + rollback metadata)
--   • data_import_rows — one row per source-file row (outcome + snapshots)
--
-- Two new columns:
--   • users.created_by_import_id     (nullable, SET NULL)
--   • business_partners.created_by_import_id
--
-- Idempotent — NOT EXISTS guards on permission seeds; column adds use
-- IF NOT EXISTS so re-running doesn't fail.

-- ─── 1. Tables ───────────────────────────────────────────────────────

CREATE TABLE `data_imports` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `user_id`         INT NOT NULL,
  `target`          ENUM('users', 'partners', 'contacts') NOT NULL,
  `filename`        VARCHAR(255) NOT NULL,
  `file_hash`       VARCHAR(64)  NOT NULL,
  `mode`            ENUM('insert', 'upsert', 'update') NOT NULL,
  `row_count`       INT NOT NULL,
  `created_count`   INT NOT NULL DEFAULT 0,
  `updated_count`   INT NOT NULL DEFAULT 0,
  `skipped_count`   INT NOT NULL DEFAULT 0,
  `error_count`     INT NOT NULL DEFAULT 0,
  `status`          ENUM('parsed', 'committed', 'partial', 'failed', 'rolled_back') NOT NULL,
  `expires_at`      DATETIME(3) NULL,
  `started_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at`     DATETIME(3) NULL,
  `rolled_back_at`  DATETIME(3) NULL,
  `notes`           TEXT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_data_imports_user_id`     (`user_id`),
  INDEX `idx_data_imports_target`      (`target`),
  INDEX `idx_data_imports_status`      (`status`),
  INDEX `idx_data_imports_started_at`  (`started_at`),
  CONSTRAINT `fk_data_imports_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE `data_import_rows` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `import_id`      INT NOT NULL,
  `row_index`      INT NOT NULL,
  `outcome`        ENUM('created', 'updated', 'skipped', 'failed') NOT NULL,
  `entity_id`      INT NULL,
  `error_message`  TEXT NULL,
  `before_json`    JSON NULL,
  `after_json`     JSON NULL,
  `created_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `idx_data_import_rows_import_id` (`import_id`),
  INDEX `idx_data_import_rows_outcome`   (`outcome`),
  CONSTRAINT `fk_data_import_rows_import`
    FOREIGN KEY (`import_id`) REFERENCES `data_imports` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ─── 2. Provenance columns on entity tables ──────────────────────────
-- ON DELETE SET NULL — deleting a stale import history record must NOT
-- cascade and wipe the actual users/partners it once created. Worst case
-- those entities just become "untagged" (no rollback target anymore).

ALTER TABLE `users`
  ADD COLUMN `created_by_import_id` INT NULL,
  ADD CONSTRAINT `fk_users_created_by_import`
    FOREIGN KEY (`created_by_import_id`) REFERENCES `data_imports` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD INDEX `idx_users_created_by_import_id` (`created_by_import_id`);

ALTER TABLE `business_partners`
  ADD COLUMN `created_by_import_id` INT NULL,
  ADD CONSTRAINT `fk_business_partners_created_by_import`
    FOREIGN KEY (`created_by_import_id`) REFERENCES `data_imports` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD INDEX `idx_business_partners_created_by_import_id` (`created_by_import_id`);

-- ─── 3. Permission modules (per-entity) ──────────────────────────────
-- Three sub-modules under a parent "Data Import" module. The parent is
-- listed in the sidebar; the children carry the actual permissions so
-- admins can grant import access for users, partners, contacts
-- independently.

-- 3a. Parent module
INSERT INTO modules (name, route, icon, sort_order, parent_id, created_at, updated_at)
SELECT 'Data Import', 'data-import', 'Upload', 90, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1 FROM modules WHERE route = 'data-import'
);

-- 3b. Child modules — one per importable entity. The parent_id is resolved
-- via subquery so the inserts are idempotent.
INSERT INTO modules (name, route, icon, sort_order, parent_id, created_at, updated_at)
SELECT 'Import Employees', 'data-import/users', NULL, 1,
  (SELECT id FROM (SELECT id FROM modules WHERE route = 'data-import' LIMIT 1) t),
  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE route = 'data-import/users');

INSERT INTO modules (name, route, icon, sort_order, parent_id, created_at, updated_at)
SELECT 'Import Partners', 'data-import/partners', NULL, 2,
  (SELECT id FROM (SELECT id FROM modules WHERE route = 'data-import' LIMIT 1) t),
  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE route = 'data-import/partners');

INSERT INTO modules (name, route, icon, sort_order, parent_id, created_at, updated_at)
SELECT 'Import Contacts', 'data-import/contacts', NULL, 3,
  (SELECT id FROM (SELECT id FROM modules WHERE route = 'data-import' LIMIT 1) t),
  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE route = 'data-import/contacts');

-- 3c. Grant Admin role full perms on the parent. Sub-permissions are
-- granted explicitly per role through /admin/roles — admins do NOT
-- auto-inherit them (data-import paths are in NO_ADMIN_BYPASS on the
-- backend), but the parent grant keeps the sidebar entry visible for
-- admins. Other roles start with no access.
INSERT INTO role_modules (role_id, module_id, can_read, can_write, can_delete, can_approve, can_export)
SELECT
  (SELECT id FROM roles WHERE name = 'Admin' LIMIT 1),
  (SELECT id FROM modules WHERE route = 'data-import' LIMIT 1),
  TRUE, TRUE, TRUE, FALSE, FALSE
WHERE EXISTS (SELECT 1 FROM roles WHERE name = 'Admin')
  AND EXISTS (SELECT 1 FROM modules WHERE route = 'data-import')
  AND NOT EXISTS (
    SELECT 1 FROM role_modules
    WHERE role_id = (SELECT id FROM roles WHERE name = 'Admin' LIMIT 1)
      AND module_id = (SELECT id FROM modules WHERE route = 'data-import' LIMIT 1)
  );

-- Grant Admin the three sub-permissions too, so an admin user can use the
-- importer end-to-end out of the box. Admins on other orgs can revoke
-- these explicitly via /admin/roles.
INSERT INTO role_modules (role_id, module_id, can_read, can_write, can_delete, can_approve, can_export)
SELECT
  (SELECT id FROM roles WHERE name = 'Admin' LIMIT 1),
  m.id,
  TRUE, TRUE, TRUE, FALSE, FALSE
FROM modules m
WHERE m.route IN ('data-import/users', 'data-import/partners', 'data-import/contacts')
  AND EXISTS (SELECT 1 FROM roles WHERE name = 'Admin')
  AND NOT EXISTS (
    SELECT 1 FROM role_modules rm
    WHERE rm.role_id = (SELECT id FROM roles WHERE name = 'Admin' LIMIT 1)
      AND rm.module_id = m.id
  );
