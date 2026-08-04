-- Estimated duration (calendar days) at both the deliverable level
-- and the per-zone level, for drawing the Gantt bar.
-- (Tier E #10 revision, 2026-08-02.)

ALTER TABLE `project_deliverables`
  ADD COLUMN `estimated_duration_days` INT NULL;

ALTER TABLE `zone_deliverable_targets`
  ADD COLUMN `estimated_duration_days` INT NULL;
