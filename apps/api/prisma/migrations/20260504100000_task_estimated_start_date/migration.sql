-- Estimated start date is the *planning* forecast for when a task should
-- begin, separate from `start_date` (which is the actual day work began).
-- Nullable; no backfill needed.

ALTER TABLE `tasks`
  ADD COLUMN `estimated_start_date` DATE NULL AFTER `completion_pct`;
