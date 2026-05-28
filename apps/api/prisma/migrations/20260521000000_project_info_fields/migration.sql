-- Project Info — free-text fields surfaced on the new Project Info tab.
--
-- All four are optional and free-text by design; the structured side
-- (services, deliverables, file storage) lives in dedicated tables. The
-- ProjectInfo tab is a fast-edit dashboard for the kind of metadata
-- that doesn't justify its own data model (yet) but still needs to
-- live with the project record so it survives team changes.

ALTER TABLE `projects`
  ADD COLUMN `authoring_tool_version` VARCHAR(100) NULL,
  ADD COLUMN `weekly_meeting_day`     VARCHAR(100) NULL,
  ADD COLUMN `file_system_link`       VARCHAR(500) NULL,
  ADD COLUMN `services_per_contract`  TEXT         NULL;
