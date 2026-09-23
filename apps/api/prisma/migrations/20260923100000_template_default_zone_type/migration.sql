-- QA3 follow-up (2026-09-23): Template.defaultZoneType
--
-- Adds a nullable string column on `templates` that Zone Template
-- authors set at create/edit time to tag the template as a "Level" /
-- "Building" / "Site" / … template. When a target project (or another
-- template) references this template via `Copy from Zone Template`,
-- the destination zone's zoneType inherits this value instead of the
-- historical fallback to 'zone'.
--
-- Values mirror the Zone.zoneType enum on the Prisma side (frontend
-- constants: site / building / level / zone / area / section / wing /
-- floor). Kept as a plain VARCHAR here so the existing zoneType
-- write path (already a string column on `zones`) stays symmetric.
-- Old templates leave the column NULL, which the caller reads as
-- "no default — pick 'zone'" for back-compat.

ALTER TABLE `templates`
  ADD COLUMN `default_zone_type` VARCHAR(32) NULL;
