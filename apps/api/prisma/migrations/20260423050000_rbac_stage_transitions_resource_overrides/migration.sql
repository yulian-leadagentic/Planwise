-- CreateTable: role_stage_transitions
CREATE TABLE `role_stage_transitions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `role_id` INTEGER NOT NULL,
    `from_status` VARCHAR(30) NOT NULL,
    `to_status` VARCHAR(30) NOT NULL,

    INDEX `role_stage_transitions_role_id_idx`(`role_id`),
    UNIQUE INDEX `role_stage_transitions_role_id_from_status_to_status_key`(`role_id`, `from_status`, `to_status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: resource_overrides
CREATE TABLE `resource_overrides` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `resource_type` VARCHAR(30) NOT NULL,
    `resource_id` INTEGER NOT NULL,
    `role_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `can_read` BOOLEAN NOT NULL DEFAULT true,
    `can_write` BOOLEAN NOT NULL DEFAULT false,
    `can_delete` BOOLEAN NOT NULL DEFAULT false,

    INDEX `resource_overrides_resource_type_resource_id_idx`(`resource_type`, `resource_id`),
    INDEX `resource_overrides_role_id_idx`(`role_id`),
    INDEX `resource_overrides_user_id_idx`(`user_id`),
    UNIQUE INDEX `resource_overrides_resource_type_resource_id_role_id_user_id_key`(`resource_type`, `resource_id`, `role_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `role_stage_transitions` ADD CONSTRAINT `role_stage_transitions_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_overrides` ADD CONSTRAINT `resource_overrides_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `resource_overrides` ADD CONSTRAINT `resource_overrides_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
