-- Add project_id to activity_logs so the per-project Activity tab can
-- filter by project without joining through entity-specific lookup
-- chains (e.g. task → projectId, time_entry → task → projectId). Each
-- caller fills this in at log time; the column is nullable because
-- truly global actions (auth, admin config) have no project context.
ALTER TABLE `activity_logs` ADD COLUMN `project_id` INT NULL;

-- Composite index drives the "show me this project's last N events"
-- query — orderBy createdAt DESC with WHERE project_id = ? is the hot
-- path that ActivityFeed hits every time a project tab opens.
CREATE INDEX `activity_logs_project_id_created_at_idx`
  ON `activity_logs` (`project_id`, `created_at`);
