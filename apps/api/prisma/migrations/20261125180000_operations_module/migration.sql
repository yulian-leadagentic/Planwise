-- QA6 P7 (PR-056, owner's decision 25.11) — Operations becomes its own
-- permission module.
--
-- Until now the Operations dashboard rode on `projects:read` (its old
-- '/operations' sub-module row was deleted by
-- 20260808100000_task_ops_notes), so every employee could open it. From
-- this release every `dashboard/operations*` and `workload/*` route needs
-- `operations:read` (RolesGuard; Admin passes through the usual bypass).
--
-- This migration only inserts the module row: a top-level module, so
-- Admin › Roles lists it and it can be switched on or off per role. The
-- role grants (Admin, "Depatment lead", "BIM leader") are written by the
-- dry-run-first backfill POST /admin/backfills/qa6-operations-grants,
-- and by both seeders for fresh databases.
--
-- Idempotent — re-runs are no-ops thanks to the NOT EXISTS guard.

INSERT INTO modules (name, route, icon, sort_order, parent_id, created_at, updated_at)
SELECT 'Operations', '/operations', 'Activity', 11, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1 FROM modules WHERE route IN ('/operations', 'operations') OR name = 'Operations'
);
