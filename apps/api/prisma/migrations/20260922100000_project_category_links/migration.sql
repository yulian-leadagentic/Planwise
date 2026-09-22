-- QA3 Wave-1 Commit 3C · PR-037 multi-select Project Categories.
--
-- Adds a junction table between Project and ProjectType so a project can
-- carry more than one category. Project.projectTypeId STAYS the PRIMARY
-- category — rollups/grouping still read that single FK and never
-- multi-count. This junction is additive: every existing project gets a
-- backfilled link row for its current primary FK.
--
-- Hand-written (shadow-DB blocked on `amec` user, house convention).
-- Idempotent on re-run:
--   * CREATE TABLE IF NOT EXISTS on the junction;
--   * INSERT IGNORE on backfill so re-running never duplicates a link.
-- Reversible via one commit: DROP TABLE + revert schema.prisma + revert
-- service/DTO changes.

CREATE TABLE IF NOT EXISTS `project_category_links` (
  `project_id`      INT NOT NULL,
  `project_type_id` INT NOT NULL,
  `created_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`project_id`, `project_type_id`),
  INDEX `project_category_links_project_type_id_idx` (`project_type_id`),
  CONSTRAINT `project_category_links_project_id_fkey`
    FOREIGN KEY (`project_id`)      REFERENCES `projects` (`id`)      ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `project_category_links_project_type_id_fkey`
    FOREIGN KEY (`project_type_id`) REFERENCES `project_types` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill: every existing project (including archived, excluding
-- soft-deleted) gets a link row pointing at its current primary FK.
-- INSERT IGNORE keeps this idempotent — a re-run inserts nothing.
INSERT IGNORE INTO `project_category_links` (`project_id`, `project_type_id`)
SELECT `id`, `project_type_id`
FROM `projects`
WHERE `deleted_at` IS NULL;
