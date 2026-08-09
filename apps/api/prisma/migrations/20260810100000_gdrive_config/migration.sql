-- Migration: gdrive_config
--
-- Google Drive integration (G1 + G2). Introduces:
--   • project_files.kind                — extended with `drive` value
--   • project_files.web_view_link       — the Drive `webViewLink`
--   • project_files.task_id             — optional Task attachment
--   • project_files.deliverable_id      — optional Deliverable attachment
--   • org_drive_configs                 — one row per organization; the
--                                         service-account JSON key lives
--                                         here as AES-256-GCM (ciphertext
--                                         + iv + tag + keyVersion) — never
--                                         plaintext, written exclusively
--                                         through SecretCryptoService.
--   • drive_folder_links                — cache of (entityType, entityId)
--                                         → folderId so ensureFolder is
--                                         O(1) after first creation.
--
-- All changes are additive on project_files (new nullable columns +
-- enum-value append). Existing rows behave identically.
--
-- Written by hand rather than via `prisma migrate dev` because the local
-- MySQL user (`amec`) lacks CREATE DATABASE / DROP DATABASE, which the
-- shadow-DB creation step needs — same constraint as the SSO P1 migration.
-- `prisma migrate deploy` will apply this verbatim.
--
-- Google permission model — NOTE FOR REVIEWERS:
--   Planwise does NOT set or modify Google Drive permissions anywhere.
--   Access to files is controlled ENTIRELY by the customer's Shared
--   Drive membership on the Google side; the service account is the
--   only Planwise-side identity, and it only touches files that
--   already live inside the configured Shared Drive.

-- 1) ProjectFile: extend enum + add drive metadata columns.
-- MariaDB / MySQL: append a value to the ENUM. Order matters for the
-- generated Prisma client to stay in sync — the new value goes LAST
-- so existing rows keep their column ordinal.
ALTER TABLE `project_files`
    MODIFY COLUMN `kind` ENUM('upload', 'link', 'drive') NOT NULL;

ALTER TABLE `project_files`
    ADD COLUMN `web_view_link` VARCHAR(1000) NULL,
    ADD COLUMN `task_id` INTEGER NULL,
    ADD COLUMN `deliverable_id` INTEGER NULL;

CREATE INDEX `project_files_task_id_idx` ON `project_files`(`task_id`);
CREATE INDEX `project_files_deliverable_id_idx` ON `project_files`(`deliverable_id`);

ALTER TABLE `project_files`
    ADD CONSTRAINT `project_files_task_id_fkey`
    FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `project_files`
    ADD CONSTRAINT `project_files_deliverable_id_fkey`
    FOREIGN KEY (`deliverable_id`) REFERENCES `project_deliverables`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) org_drive_configs.
CREATE TABLE `org_drive_configs` (
    `id`                 INTEGER NOT NULL AUTO_INCREMENT,
    `organization_id`    INTEGER NULL,
    `enabled`            BOOLEAN NOT NULL DEFAULT false,
    `sa_ciphertext`      LONGBLOB NOT NULL,
    `sa_iv`              LONGBLOB NOT NULL,
    `sa_tag`             LONGBLOB NOT NULL,
    `key_version`        INTEGER NOT NULL,
    `shared_drive_id`    VARCHAR(191) NOT NULL,
    `root_folder_id`     VARCHAR(191) NULL,
    `updated_by`         INTEGER NULL,
    `created_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`         DATETIME(3) NOT NULL,

    UNIQUE INDEX `org_drive_configs_organization_id_key`(`organization_id`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) drive_folder_links.
CREATE TABLE `drive_folder_links` (
    `id`             INTEGER NOT NULL AUTO_INCREMENT,
    `entity_type`    VARCHAR(20) NOT NULL,
    `entity_id`      INTEGER NOT NULL,
    `folder_id`      VARCHAR(191) NOT NULL,
    `web_view_link`  VARCHAR(1000) NULL,
    `created_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `drive_folder_links_entity_type_entity_id_key`(`entity_type`, `entity_id`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
