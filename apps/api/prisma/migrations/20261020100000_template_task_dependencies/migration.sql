-- T1-1 · Template Task dependencies (additive, 2026-10-20)
--
-- Mirrors the project-level `task_dependencies` join at the Deliverable
-- Template layer. Backs `TemplateTaskDependency` in prisma/schema.prisma.
-- Nothing is dropped; existing templates keep working untouched.
--
-- Column naming note: columns are camelCase to match the prisma model
-- field names (no `@map`), unlike the older `task_dependencies` table.
-- Yulian-approved per docs/bm2/planwise-template-task-order-SPEC.md
-- (WORK ORDER §T1-1).
--
-- Cascade semantics: either endpoint going away removes the join row.
-- The downstream project tasks still own their own `TaskDependency`
-- rows (materialized at apply-time) — those are not touched by changes
-- here, since the template graph is a design-time artefact.

-- CreateTable
CREATE TABLE `template_task_dependencies` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `templateTaskId` INTEGER NOT NULL,
  `dependsOnTemplateTaskId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `template_task_dep_pair_unique`(`templateTaskId`, `dependsOnTemplateTaskId`),
  INDEX `template_task_dependencies_templateTaskId_idx`(`templateTaskId`),
  INDEX `template_task_dependencies_dependsOnTemplateTaskId_idx`(`dependsOnTemplateTaskId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `template_task_dependencies`
  ADD CONSTRAINT `template_task_dependencies_templateTaskId_fkey`
  FOREIGN KEY (`templateTaskId`) REFERENCES `template_tasks`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `template_task_dependencies`
  ADD CONSTRAINT `template_task_dependencies_dependsOnTemplateTaskId_fkey`
  FOREIGN KEY (`dependsOnTemplateTaskId`) REFERENCES `template_tasks`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
