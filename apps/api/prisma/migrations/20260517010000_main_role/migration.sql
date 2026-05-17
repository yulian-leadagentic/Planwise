-- Main Role on BusinessPartner. Replaces the many-to-many
-- business_partner_roles chips as the source-of-truth for "what kind of
-- contact is this". The roles table is left in place (read-only) until
-- M7 cleanup so historical data isn't lost mid-cutover.
--
-- Optional column (NULL allowed) so legacy partners without a chip
-- aren't blocked from save. The drawer surfaces a soft prompt when
-- mainRoleTypeId IS NULL.
ALTER TABLE `business_partners`
  ADD COLUMN `main_role_type_id` INT NULL AFTER `notes`;

-- Soft FK: SET NULL on delete (don't orphan partners just because a
-- role-type is removed from the catalog). CASCADE on update so
-- renumbering a role-type id flows through.
ALTER TABLE `business_partners`
  ADD CONSTRAINT `business_partners_main_role_type_id_fk`
    FOREIGN KEY (`main_role_type_id`)
    REFERENCES `partner_role_types`(`id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- Index for filter queries like `WHERE main_role_type_id = ?` on the
-- BP list page and Project Team pickers.
CREATE INDEX `business_partners_main_role_type_id_idx`
  ON `business_partners`(`main_role_type_id`);

-- Backfill: for each BP that has at least one business_partner_roles
-- row, copy the lowest-id (= first-assigned) role's roleTypeId into
-- main_role_type_id. Matches the user's chosen migration policy:
-- "pick first-assigned".
--
-- Correlated subquery is fine here — business_partner_roles is
-- typically a few rows per BP, and this only runs once at deploy.
UPDATE `business_partners` bp
  SET `main_role_type_id` = (
    SELECT bpr.role_type_id
    FROM `business_partner_roles` bpr
    WHERE bpr.business_partner_id = bp.id
    ORDER BY bpr.id ASC
    LIMIT 1
  )
  WHERE `main_role_type_id` IS NULL;
