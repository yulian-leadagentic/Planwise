-- One-off backfill: time entries logged via the QuickTimeLog and
-- TaskDrawer paths were created with project_id = NULL even when the
-- linked task belonged to a project. Every project-summary and
-- planning view filters by time_entries.project_id, so those entries
-- were invisibly excluded from per-project rollups.
--
-- This migration copies the task's project_id into the entry whenever
-- the entry has a taskId but no projectId. After this, every read
-- path that filters by project_id will surface them correctly.
--
-- The application code is also patched to (a) auto-fill project_id on
-- create when the caller supplied a taskId but no projectId, and
-- (b) aggregate logged time via task.projectId in addition to / instead
-- of entry.projectId — so this migration covers historical rows and
-- the app keeps future rows clean. Belt-and-suspenders.
UPDATE time_entries te
JOIN tasks t ON t.id = te.task_id
SET te.project_id = t.project_id
WHERE te.project_id IS NULL
  AND te.task_id IS NOT NULL
  AND t.project_id IS NOT NULL;
