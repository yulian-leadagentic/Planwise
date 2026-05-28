-- First-class per-project Deliverable entity.
--
-- Why: until now a task's deliverable was the catalog `templates` row it was
-- linked to (tasks.deliverable_template_id), and per-project renames lived in
-- a cosmetic JSON blob (projects.deliverable_name_overrides). That made the
-- rename display-only — it could not carry its own order/status/attributes and
-- was invisible to anything that didn't know to read the JSON. A deliverable
-- rename is not just a label: it changes the project's deliverable as seen by
-- the PM and the customer. So we promote it to a real, project-owned row.
--
-- Model: project_deliverables is instantiated FROM a catalog template
-- (source_template_id) but owns its own name/description/sort_order/status.
-- The catalog template is never mutated. service_id points at the Service
-- (phases) line, inherited from the template's phase. Tasks now link to a
-- project_deliverables row via tasks.project_deliverable_id; the legacy
-- deliverable_template_id is kept for back-compat / provenance.
--
-- Backfill: one project_deliverables row per distinct (project, template)
-- pair currently used by live tasks. name = the project's JSON override for
-- that template if present, else the template name. Then re-point every task.

-- 1. Add the new task link column.
ALTER TABLE `tasks` ADD COLUMN `project_deliverable_id` INTEGER NULL;

-- 2. Create the project_deliverables table.
CREATE TABLE `project_deliverables` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `project_id` INTEGER NOT NULL,
    `source_template_id` INTEGER NULL,
    `service_id` INTEGER NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(30) NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,

    INDEX `project_deliverables_project_id_idx`(`project_id`),
    INDEX `project_deliverables_source_template_id_idx`(`source_template_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3. Index + FKs.
CREATE INDEX `tasks_project_deliverable_id_idx` ON `tasks`(`project_deliverable_id`);

ALTER TABLE `tasks` ADD CONSTRAINT `tasks_project_deliverable_id_fkey`
  FOREIGN KEY (`project_deliverable_id`) REFERENCES `project_deliverables`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `project_deliverables` ADD CONSTRAINT `project_deliverables_project_id_fkey`
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `project_deliverables` ADD CONSTRAINT `project_deliverables_source_template_id_fkey`
  FOREIGN KEY (`source_template_id`) REFERENCES `templates`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `project_deliverables` ADD CONSTRAINT `project_deliverables_service_id_fkey`
  FOREIGN KEY (`service_id`) REFERENCES `phases`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Backfill: one row per distinct (project_id, deliverable_template_id) used
--    by a live (non-deleted) task. The per-project name comes from the JSON
--    override (projects.deliverable_name_overrides keyed by template id) when
--    set & non-blank, otherwise the catalog template name. service_id is the
--    template's phase. sort_order is sequential within each project, ordered
--    by template name for a stable, readable default.
INSERT INTO `project_deliverables`
  (`project_id`, `source_template_id`, `service_id`, `name`, `sort_order`, `status`, `created_at`, `updated_at`)
SELECT
  d.`project_id`,
  d.`deliverable_template_id` AS source_template_id,
  dt.`phase_id` AS service_id,
  COALESCE(
    NULLIF(
      TRIM(JSON_UNQUOTE(JSON_EXTRACT(p.`deliverable_name_overrides`,
        CONCAT('$."', d.`deliverable_template_id`, '"')))),
      ''
    ),
    dt.`name`
  ) AS name,
  ROW_NUMBER() OVER (PARTITION BY d.`project_id` ORDER BY dt.`name`) - 1 AS sort_order,
  'active' AS status,
  NOW(3),
  NOW(3)
FROM (
  SELECT DISTINCT `project_id`, `deliverable_template_id`
  FROM `tasks`
  WHERE `deliverable_template_id` IS NOT NULL AND `deleted_at` IS NULL
) d
JOIN `templates` dt ON dt.`id` = d.`deliverable_template_id`
LEFT JOIN `projects` p ON p.`id` = d.`project_id`;

-- 5. Re-point every live task to its new project_deliverables row.
UPDATE `tasks` t
JOIN `project_deliverables` pd
  ON pd.`project_id` = t.`project_id`
  AND pd.`source_template_id` = t.`deliverable_template_id`
  AND pd.`deleted_at` IS NULL
SET t.`project_deliverable_id` = pd.`id`
WHERE t.`deliverable_template_id` IS NOT NULL
  AND t.`deleted_at` IS NULL;
