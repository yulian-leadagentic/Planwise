-- AlterTable
ALTER TABLE `task_attachments` ADD COLUMN `comment_id` INTEGER NULL;

-- CreateIndex
CREATE INDEX `task_attachments_comment_id_idx` ON `task_attachments`(`comment_id`);

-- AddForeignKey
ALTER TABLE `task_attachments` ADD CONSTRAINT `task_attachments_comment_id_fkey` FOREIGN KEY (`comment_id`) REFERENCES `task_comments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
