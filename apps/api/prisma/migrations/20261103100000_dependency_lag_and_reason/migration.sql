-- T1-Lag addendum (2026-11-03) — add `lag`, `lagUnit`, `reason` columns
-- to BOTH `task_dependencies` (project level) and `template_task_dependencies`
-- (deliverable-template level). Additive, non-destructive. Backs the
-- Prisma `enum LagUnit { WORKING_DAYS CALENDAR_DAYS }` + the three new
-- fields on `TaskDependency` + `TemplateTaskDependency` in schema.prisma.
--
-- Scheduling semantics stay unchanged for existing rows:
--   * `lag` defaults to 0 → pure Finish-to-Start sequence.
--   * `lag_unit` / `lagUnit` default to `WORKING_DAYS` → internal
--     handoff (same calendar the scheduler already uses).
--   * `reason` is nullable → no justification required.
--
-- Column name casing differs between the two tables intentionally:
--   * `task_dependencies` already uses snake_case (`task_id`,
--     `depends_on_id`) because it predates the camelCase convention,
--     so we match: `lag_unit`.
--   * `template_task_dependencies` was created on 2026-10-20 with
--     camelCase (`templateTaskId`, `dependsOnTemplateTaskId`,
--     `createdAt`) so we match: `lagUnit`.
-- Prisma `@map("lag_unit")` on `TaskDependency.lagUnit` bridges the
-- model-side camelCase to the DB-side snake_case; the template-side
-- field has no `@map` and the column name matches 1:1.
--
-- `lag` is INT (not UNSIGNED): MySQL's UNSIGNED on existing INT columns
-- is a schema-breaking change in Prisma Migrate's drift detector, and
-- the >=0 guard lives at the service layer per the spec. 365 is also a
-- service-layer cap, not a DB CHECK, to keep the migration portable to
-- older MySQL versions that lack enforced CHECK constraints.

-- Project-level TaskDependency
ALTER TABLE `task_dependencies`
  ADD COLUMN `lag` INT NOT NULL DEFAULT 0,
  ADD COLUMN `lag_unit` ENUM('WORKING_DAYS', 'CALENDAR_DAYS') NOT NULL DEFAULT 'WORKING_DAYS',
  ADD COLUMN `reason` VARCHAR(255) NULL;

-- Template-level TemplateTaskDependency (camelCase column names match
-- the 2026-10-20 migration that created this table).
ALTER TABLE `template_task_dependencies`
  ADD COLUMN `lag` INT NOT NULL DEFAULT 0,
  ADD COLUMN `lagUnit` ENUM('WORKING_DAYS', 'CALENDAR_DAYS') NOT NULL DEFAULT 'WORKING_DAYS',
  ADD COLUMN `reason` VARCHAR(255) NULL;
