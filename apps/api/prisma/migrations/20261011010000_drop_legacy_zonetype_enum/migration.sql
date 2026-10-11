-- ZT-4 follow-up: drop the legacy ZoneType enum members
-- ('floor','area','zone','section') from the two ENUM columns backed by
-- Prisma's ZoneType. ZT-3 already remapped every stored row to a
-- catalog code, and the previous migration (20261011000000) flipped the
-- DEFAULT to 'building' so no new row can land on a legacy value.
--
-- Preserves the current column attributes seen in SHOW CREATE TABLE on
-- staging: utf8mb4_unicode_ci collation, NOT NULL, DEFAULT 'building'.
-- templates.default_zone_type is VARCHAR(32), NOT this enum, so it is
-- untouched by this migration.

ALTER TABLE `zones`
  MODIFY COLUMN `zone_type` ENUM('site','building','level','wing')
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    NOT NULL DEFAULT 'building';

ALTER TABLE `template_zones`
  MODIFY COLUMN `zone_type` ENUM('site','building','level','wing')
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    NOT NULL DEFAULT 'building';
