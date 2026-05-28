-- Backfill tasks.deliverable_template_id from the legacy [SERVICE:<name>]
-- description marker, making the [SERVICE:] marker the single source of
-- truth for which Deliverable a task belongs to.
--
-- Why: the Execution Board is a Zone × Deliverable matrix. Its column
-- resolver (getTaskPhaseName) prioritises the deliverable link, but most
-- tasks only carried the legacy marker, so columns/dropdown/filter mixed
-- two dimensions (deliverable names + marker names) and filtering looked
-- like it lost data. This aligns every marked task to a real deliverable.
--
-- Scope:
--   * Sets the link for tasks whose link is NULL (the ~majority).
--   * Realigns the handful whose existing link disagreed with their marker
--     (those were ad-hoc test assignments).
--   * Non-destructive: the [SERVICE:] text stays in the description.
--
-- The join is exact-name (marker === template.name) and unambiguous:
-- each of the 5 distinct markers maps 1:1 to a type='task_list' template.

UPDATE `tasks` t
JOIN `templates` dt
  ON dt.`type` = 'task_list'
  AND dt.`deleted_at` IS NULL
  AND dt.`name` = TRIM(SUBSTRING(
        t.`description`,
        LOCATE('[SERVICE:', t.`description`) + 9,
        LOCATE(']', t.`description`, LOCATE('[SERVICE:', t.`description`))
          - (LOCATE('[SERVICE:', t.`description`) + 9)
      ))
SET t.`deliverable_template_id` = dt.`id`
WHERE t.`deleted_at` IS NULL
  AND t.`description` LIKE '%[SERVICE:%';
