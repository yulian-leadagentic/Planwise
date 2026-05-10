-- One-shot data cleanup: NULL out task.deliverable_template_id rows
-- that incorrectly point at zone-templates (Template.type != 'task_list').
--
-- Why: an earlier version of zones.service.ts (applyProjectTemplate +
-- applyTaskTemplate) set deliverable_template_id to whichever Template
-- it was iterating over, including zone templates ("Building", "Typical
-- floor", "מרתף" — type=zone). Zone templates aren't deliverables, so
-- those FK values surfaced wrong labels in the planning grid's
-- "Deliverable" column. The code is now gated on
-- `template.type === 'task_list'` so no new bad rows are created.
--
-- This migration is idempotent: running it a second time matches no
-- rows. Safe to apply on staging, prod, or replay.
--
-- ROLLBACK: not strictly possible (we don't know which good values
-- were accidentally set vs. which bad ones); but no legitimate data
-- is destroyed because:
--   • These FK values were always wrong (pointed at non-deliverables)
--   • The deliverable identity for affected tasks lives in the
--     [SERVICE:xxx] description marker which this migration leaves
--     untouched, and the planning grid renders that as a fallback.
-- The column itself stays — see the previous migration
-- (20260508100000) for the schema-level rollback if needed.

UPDATE `tasks` t
JOIN `templates` tpl ON t.`deliverable_template_id` = tpl.`id`
SET t.`deliverable_template_id` = NULL
WHERE tpl.`type` <> 'task_list';
