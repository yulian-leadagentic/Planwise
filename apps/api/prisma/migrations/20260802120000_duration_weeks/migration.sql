-- Duration measured in WEEKS, not days (client feedback 2026-08-02).
-- No existing data (fresh column added same day), so a plain rename
-- is safe — no value conversion needed.
ALTER TABLE `project_deliverables`
  CHANGE COLUMN `estimated_duration_days` `estimated_duration_weeks` INT NULL;

ALTER TABLE `zone_deliverable_targets`
  CHANGE COLUMN `estimated_duration_days` `estimated_duration_weeks` INT NULL;
