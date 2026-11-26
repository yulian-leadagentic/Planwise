-- QA6 PR-063 (2026-11-26) — Operations › Workload drag-and-drop.
--
-- task_reassignments — one row per drag-and-drop move: an applied move,
-- a cross-department approval request (status `pending` until the
-- receiving department decides), and the before / after snapshot the
-- server-side Undo (15 minutes) restores. `pending_task_id` equals
-- `task_id` while a request is pending and is NULL otherwise, so the
-- unique index allows one pending request per task.
--
-- Additive: a new table, no change to existing rows.

-- CreateTable
CREATE TABLE `task_reassignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `task_id` INTEGER NOT NULL,
    `project_id` INTEGER NULL,
    `actor_id` INTEGER NOT NULL,
    `from_user_id` INTEGER NULL,
    `to_user_id` INTEGER NULL,
    `from_day` DATE NULL,
    `to_day` DATE NULL,
    `prev_assignee_ids` JSON NOT NULL,
    `new_assignee_ids` JSON NOT NULL,
    `prev_estimated_start_date` DATE NULL,
    `prev_end_date` DATE NULL,
    `prev_due_date_overridden` BOOLEAN NOT NULL,
    `new_estimated_start_date` DATE NULL,
    `new_end_date` DATE NULL,
    `new_due_date_overridden` BOOLEAN NOT NULL,
    `added_to_team` BOOLEAN NOT NULL DEFAULT false,
    `cross_department` BOOLEAN NOT NULL DEFAULT false,
    `from_org_unit_id` INTEGER NULL,
    `to_org_unit_id` INTEGER NULL,
    `approver_user_id` INTEGER NULL,
    `status` ENUM('applied', 'pending', 'approved', 'rejected', 'cancelled', 'undone', 'failed') NOT NULL,
    `pending_task_id` INTEGER NULL,
    `decided_by_id` INTEGER NULL,
    `decided_at` DATETIME(3) NULL,
    `decision_note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `task_reassignments_pending_task_id_key`(`pending_task_id`),
    INDEX `task_reassignments_task_id_created_at_idx`(`task_id`, `created_at`),
    INDEX `task_reassignments_approver_user_id_status_idx`(`approver_user_id`, `status`),
    INDEX `task_reassignments_actor_id_status_idx`(`actor_id`, `status`),
    INDEX `task_reassignments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `task_reassignments` ADD CONSTRAINT `task_reassignments_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_reassignments` ADD CONSTRAINT `task_reassignments_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_reassignments` ADD CONSTRAINT `task_reassignments_from_user_id_fkey` FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_reassignments` ADD CONSTRAINT `task_reassignments_to_user_id_fkey` FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_reassignments` ADD CONSTRAINT `task_reassignments_approver_user_id_fkey` FOREIGN KEY (`approver_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_reassignments` ADD CONSTRAINT `task_reassignments_decided_by_id_fkey` FOREIGN KEY (`decided_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
