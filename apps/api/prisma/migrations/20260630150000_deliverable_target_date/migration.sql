-- Deliverable Planning target date (Tier E #10).
ALTER TABLE `project_deliverables`
  ADD COLUMN `target_date`   DATE NULL,
  ADD COLUMN `target_months` INT NULL;
