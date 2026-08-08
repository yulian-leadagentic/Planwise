-- Migration: task_ops_notes
--
-- Adds the TaskOpsNote table used by the Operations dashboard's
-- Executive Review tab. One free-text annotation per task, editable
-- in place. Distinct from task_comments (threaded discussion, many
-- per task) because the ops view needs a single always-latest note
-- per task, not a comment stream.
--
-- Additive-only. Nothing existing is renamed or dropped.
--
-- Hand-written to match what `prisma migrate diff` would produce.
-- Shadow-DB creation is blocked locally for the `amec` user, so the
-- generate-and-copy loop doesn't work in this environment.

CREATE TABLE `task_ops_notes` (
    `id`         INTEGER      NOT NULL AUTO_INCREMENT,
    `task_id`    INTEGER      NOT NULL,
    `content`    TEXT         NOT NULL,
    `updated_by` INTEGER      NOT NULL,
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3)  NOT NULL,

    UNIQUE INDEX `task_ops_notes_task_id_key`(`task_id`),
    INDEX        `task_ops_notes_updated_by_idx`(`updated_by`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `task_ops_notes`
    ADD CONSTRAINT `task_ops_notes_task_id_fkey`
    FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `task_ops_notes`
    ADD CONSTRAINT `task_ops_notes_updated_by_fkey`
    FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Retire the /operations sub-module row. Per client feedback for
-- feat/ops-complete the Operations dashboard is a read-only view
-- accessible to anyone who can read projects (its endpoints are
-- already gated on projects:read), so it must not appear in the
-- role-permissions matrix as a grantable module. Removing the
-- Module row also cascades the role_modules rows that were
-- previously seeded for it.

DELETE FROM `role_modules`
 WHERE `module_id` IN (SELECT `id` FROM `modules` WHERE `route` = '/operations');

DELETE FROM `modules` WHERE `route` = '/operations';
