-- Add `closed_at` to projects so a user can mark a project finished
-- without deleting it. Closed projects stay queryable for audit /
-- historical reporting, but the default project-list query filters
-- them out (the UI exposes a "Show closed" toggle for the rare case
-- someone needs to find one). Nullable: NULL = still active.
--
-- The composite index supports the hot path: "list active projects
-- for the dashboard / picker / etc." (closed_at IS NULL ORDER BY id).
ALTER TABLE `projects` ADD COLUMN `closed_at` DATETIME(3) NULL;
CREATE INDEX `projects_closed_at_idx` ON `projects` (`closed_at`);
