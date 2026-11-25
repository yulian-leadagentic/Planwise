-- PR-053 (QA6, 2026-11-25) — archive templates instead of deleting them.
--
-- templates.archived_at — set when a Deliverable / Zone template is
-- archived. An archived template is left out of every list and picker
-- (GET /templates hides it by default) but stays readable by id, so
-- projects and composing templates that already use it keep working.
-- Restore sets it back to NULL. Additive and nullable, no backfill:
-- every existing template stays active.
ALTER TABLE `templates`
  ADD COLUMN `archived_at` DATETIME(3) NULL AFTER `deleted_at`;
