-- AlterEnum: add `projects` to DataImportTarget for whole-project migration runs.
ALTER TABLE `data_imports` MODIFY `target` ENUM('users', 'partners', 'contacts', 'projects') NOT NULL;

-- CreateTable: generic audit log for the BM-style whole-project importer.
-- One row per entity touched by the run. Rollback walks DESC by sort_order
-- so children (time_entry → task_assignee → task → deliverable → zone)
-- are deleted before their parents. Catalog rows (phase, service,
-- profession, department) are recorded with action='linked' so rollback
-- skips them — they're shared with other data.
CREATE TABLE `import_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `import_id` INTEGER NOT NULL,
    `entity_type` VARCHAR(50) NOT NULL,
    `entity_id` INTEGER NOT NULL,
    `action` VARCHAR(20) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `import_logs_import_id_sort_order_idx`(`import_id`, `sort_order`),
    INDEX `import_logs_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `import_logs` ADD CONSTRAINT `import_logs_import_id_fkey` FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
