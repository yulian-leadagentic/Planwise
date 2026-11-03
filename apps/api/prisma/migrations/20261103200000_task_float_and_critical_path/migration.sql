-- D7-Float (2026-11-03) — Float days and critical-path flag persisted
-- on each successful scheduler commit. Both fields are additive, no
-- backfill: existing rows default to NULL float and FALSE
-- on_critical_path until the next SchedulerService.scheduleDeliverableAndCommit
-- (or saveAndUpdateDueDates) runs over them.
ALTER TABLE `tasks`
  ADD COLUMN `float_days` INT NULL,
  ADD COLUMN `on_critical_path` BOOLEAN NOT NULL DEFAULT FALSE;
