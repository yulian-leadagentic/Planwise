-- Per-project Deliverable display-name overrides.
--
-- Stored as JSON keyed by deliverableTemplateId. Empty / null means "use
-- the source template name". Lets a single template (e.g. "BIM
-- Foundation") render under different labels in different projects
-- without forking the template catalog.

ALTER TABLE `projects`
  ADD COLUMN `deliverable_name_overrides` JSON NULL;
