-- Migration: org_units
--
-- Additive-only. Introduces the OrgUnit hierarchy and the User.orgUnitId
-- home-unit link. Nothing existing is renamed or dropped, and every new
-- column is nullable so pre-existing rows continue to behave identically
-- (a NULL home unit means "not in the org chart yet", which the access
-- layer treats as "not managed by anyone", which reproduces today's
-- behaviour exactly).
--
-- Named org_units to match the @@map on the Prisma model.

-- 1) org_units table.
CREATE TABLE `org_units` (
    `id`              INTEGER NOT NULL AUTO_INCREMENT,
    `name`            VARCHAR(191) NOT NULL,
    `code`            VARCHAR(191) NULL,
    `parent_id`       INTEGER NULL,
    `manager_user_id` INTEGER NULL,
    `path`            VARCHAR(191) NOT NULL DEFAULT '/',
    `depth`           INTEGER NOT NULL DEFAULT 0,
    `sort_order`      INTEGER NOT NULL DEFAULT 0,
    `deleted_at`      DATETIME(3) NULL,

    UNIQUE INDEX `org_units_code_key`(`code`),
    INDEX        `org_units_parent_id_idx`(`parent_id`),
    INDEX        `org_units_path_idx`(`path`),
    INDEX        `org_units_manager_user_id_idx`(`manager_user_id`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2) User → home unit column + index.
ALTER TABLE `users` ADD COLUMN `org_unit_id` INTEGER NULL;
CREATE INDEX `users_org_unit_id_idx` ON `users`(`org_unit_id`);

-- 3) Foreign keys.
--    All use ON DELETE SET NULL so unwiring a parent / manager / home unit
--    never cascades a hard delete into users or child units. Matches the
--    "additive + nullable" contract on the Prisma model.
ALTER TABLE `org_units`
  ADD CONSTRAINT `org_units_parent_id_fkey`
  FOREIGN KEY (`parent_id`) REFERENCES `org_units`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `org_units`
  ADD CONSTRAINT `org_units_manager_user_id_fkey`
  FOREIGN KEY (`manager_user_id`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `users`
  ADD CONSTRAINT `users_org_unit_id_fkey`
  FOREIGN KEY (`org_unit_id`) REFERENCES `org_units`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
