-- Backfill: every Business Partner whose `main_role_type_id` is set must
-- also have a matching row in `business_partner_roles`, otherwise the
-- role-based filters across the app (notably the project Customer
-- dropdown, which queries roleType=customer) won't see them.
--
-- The Partners UI's "Main Role" picker historically wrote only the single
-- `main_role_type_id` column and skipped the `business_partner_roles` join
-- table, so BPs with Main Role = Customer were tagged in one place but
-- invisible to the other. From here forward the BP service syncs the two
-- on every create/update; this one-time migration heals existing data.
--
-- Idempotent: the `(business_partner_id, role_type_id)` unique index makes
-- INSERT IGNORE skip rows that already exist. Inserted rows are flagged
-- `is_primary = 1` because the Main Role is, by definition, the primary
-- categorization of the partner.

INSERT IGNORE INTO `business_partner_roles`
  (`business_partner_id`, `role_type_id`, `is_primary`, `created_at`)
SELECT
  bp.`id`,
  bp.`main_role_type_id`,
  1,
  NOW(3)
FROM `business_partners` bp
WHERE bp.`main_role_type_id` IS NOT NULL
  AND bp.`deleted_at` IS NULL;
