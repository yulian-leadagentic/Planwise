-- F5 — Project Stage Milestones (Notion-style status board).
--
-- Two tables: catalog + per-project status. Plus a small seed of common
-- milestones so the board has content out of the box; admins can edit
-- via SQL or a future /admin page.

CREATE TABLE `project_stage_milestones` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `code`        VARCHAR(50)  NOT NULL,
  `name`        VARCHAR(150) NOT NULL,
  `description` TEXT NULL,
  `sort_order`  INT NOT NULL DEFAULT 0,
  `is_active`   BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_project_stage_milestones_code` (`code`)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE `project_milestone_statuses` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `project_id`    INT NOT NULL,
  `milestone_id`  INT NOT NULL,
  `is_completed`  BOOLEAN NOT NULL DEFAULT FALSE,
  `completed_at`  DATETIME(3) NULL,
  `completed_by`  INT NULL,
  `notes`         TEXT NULL,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_project_milestone` (`project_id`, `milestone_id`),
  INDEX `idx_pms_project`   (`project_id`),
  INDEX `idx_pms_milestone` (`milestone_id`),
  CONSTRAINT `fk_pms_project`
    FOREIGN KEY (`project_id`)   REFERENCES `projects` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_pms_milestone`
    FOREIGN KEY (`milestone_id`) REFERENCES `project_stage_milestones` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Seed common milestones (matches the Hebrew column names from the
-- user-shared board screenshot). Idempotent: skipped if code exists.
INSERT INTO project_stage_milestones (code, name, sort_order, is_active, created_at, updated_at)
SELECT * FROM (
  SELECT 'urs_production'          AS code, 'URS Production'                   AS name, 10 AS sort_order, TRUE AS is_active, CURRENT_TIMESTAMP(3) AS c, CURRENT_TIMESTAMP(3) AS u UNION ALL
  SELECT 'architectural_review',        'Architectural Review',                  20, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3) UNION ALL
  SELECT 'stage_1',                     'Stage 1',                               30, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3) UNION ALL
  SELECT 'arch_review_construction',    'Architectural Review (Construction)',   40, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3) UNION ALL
  SELECT 'stage_1_followup',            'Stage 1 — Follow Up',                   50, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3) UNION ALL
  SELECT 'summary_document',            'Summary Document',                      60, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3) UNION ALL
  SELECT 'aesthetic_object',            'Aesthetic Object',                      70, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
) AS seeds
WHERE NOT EXISTS (
  SELECT 1 FROM project_stage_milestones m WHERE m.code = seeds.code
);
