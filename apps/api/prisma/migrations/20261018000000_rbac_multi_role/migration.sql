-- §14 RBAC multi-role (2026-10-18)
--
-- Adds:
--   • `roles.is_system`           — marks seeded "default group" rows
--     whose grants the seed re-asserts on each run (editable only
--     via code — the admin UI renders them read-only and the BE
--     returns 403 on `POST /admin/roles/:id/modules`).
--   • `user_roles`                — user × role M2M junction, with
--     audit columns `granted_at` + `granted_by_id`.
--
-- Legacy `users.role_id` is NOT dropped — kept writable as the display
-- "primary (legacy)" chip. Runtime permission read is the OR union of
-- every row in `user_roles` for the current user; `common/guards/
-- roles.guard.ts` falls back to the legacy `role_id` lookup only when
-- `user_roles` is empty for that user. The one-shot backfill endpoint
-- `POST /admin/backfills/rbac-m1-seed-user-roles` seeds one row per
-- user from `(user.id, user.role_id)` with `?dryRun=true` for preview.

-- 1) roles.is_system (additive)
ALTER TABLE `roles` ADD COLUMN `is_system` TINYINT(1) NOT NULL DEFAULT 0;

-- 2) user_roles M2M
CREATE TABLE `user_roles` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `user_id`        INT NOT NULL,
  `role_id`        INT NOT NULL,
  `granted_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `granted_by_id`  INT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_user_roles_user_role` (`user_id`,`role_id`),
  INDEX `ix_user_roles_user` (`user_id`),
  INDEX `ix_user_roles_role` (`role_id`),
  CONSTRAINT `fk_user_roles_user`       FOREIGN KEY (`user_id`)       REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_user_roles_role`       FOREIGN KEY (`role_id`)       REFERENCES `roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_user_roles_grantedby`  FOREIGN KEY (`granted_by_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
