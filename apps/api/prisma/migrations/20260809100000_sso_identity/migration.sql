-- Migration: sso_identity
--
-- Phase-1 enterprise SSO scaffolding. Introduces:
--   • users.password              — now NULLABLE (SSO-only users have no local hash)
--   • users.allow_password_login  — hard toggle so an admin can lock a user to SSO
--   • org_auth_configs            — one row per (organization × provider); the
--                                   client secret lives here as AES-256-GCM
--                                   (ciphertext + iv + tag + keyVersion) — never
--                                   plaintext, written exclusively through
--                                   SecretCryptoService.
--   • user_identities             — stable (provider, subject) → user link.
--                                   Subject is the IdP-side `oid`/`sub`, NEVER
--                                   the email; email changes must not break
--                                   linkage.
--
-- All changes are additive on the users table (nullable column + new bool
-- with default true) so existing rows behave identically until an admin
-- flips the SSO switches.
--
-- Written by hand rather than via `prisma migrate dev` because the local
-- MySQL user (`amec`) lacks CREATE DATABASE / DROP DATABASE, which the
-- shadow-DB creation step needs. `prisma migrate deploy` will apply this
-- verbatim.

-- 1) User: password NULLABLE + allow_password_login toggle.
ALTER TABLE `users`
    MODIFY COLUMN `password` VARCHAR(191) NULL;

ALTER TABLE `users`
    ADD COLUMN `allow_password_login` BOOLEAN NOT NULL DEFAULT true;

-- 2) org_auth_configs.
CREATE TABLE `org_auth_configs` (
    `id`                 INTEGER NOT NULL AUTO_INCREMENT,
    `organization_id`    INTEGER NULL,
    `provider`           VARCHAR(20) NOT NULL,
    `enabled`            BOOLEAN NOT NULL DEFAULT false,
    `tenant_id`          VARCHAR(191) NULL,
    `client_id`          VARCHAR(191) NOT NULL,
    `secret_ciphertext`  LONGBLOB NOT NULL,
    `secret_iv`          LONGBLOB NOT NULL,
    `secret_tag`         LONGBLOB NOT NULL,
    `key_version`        INTEGER NOT NULL,
    `allowed_domains`    VARCHAR(500) NOT NULL DEFAULT '',
    `default_role_id`    INTEGER NOT NULL,
    `sso_only`           BOOLEAN NOT NULL DEFAULT false,
    `updated_by`         INTEGER NULL,
    `created_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`         DATETIME(3) NOT NULL,

    UNIQUE INDEX `org_auth_configs_organization_id_provider_key`(`organization_id`, `provider`),
    INDEX        `org_auth_configs_default_role_id_idx`(`default_role_id`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `org_auth_configs`
  ADD CONSTRAINT `org_auth_configs_default_role_id_fkey`
  FOREIGN KEY (`default_role_id`) REFERENCES `roles`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) user_identities.
CREATE TABLE `user_identities` (
    `id`         INTEGER NOT NULL AUTO_INCREMENT,
    `user_id`    INTEGER NOT NULL,
    `provider`   VARCHAR(20) NOT NULL,
    `subject`    VARCHAR(191) NOT NULL,
    `email`      VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_identities_provider_subject_key`(`provider`, `subject`),
    INDEX        `user_identities_user_id_idx`(`user_id`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `user_identities`
  ADD CONSTRAINT `user_identities_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
