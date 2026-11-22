-- Permissions round 3 (2026-11-22) — erase secrets the users importer
-- stored in plain text in the per-row import report.
--
-- `data_import_rows.after_json` held the generated initial password
-- (`generatedPassword`) of every imported employee and, for finance
-- users, the hourly rate (`salaryHourly`). The importer no longer writes
-- either key (initial passwords are shown once in the commit response,
-- never stored); this removes the copies already in the table.
-- JSON_REMOVE ignores a path that is absent, and the WHERE limits the
-- rewrite to rows that actually carry one of the keys.

UPDATE `data_import_rows`
  SET `after_json` = JSON_REMOVE(`after_json`, '$.generatedPassword', '$.salaryHourly')
  WHERE `after_json` IS NOT NULL
    AND JSON_CONTAINS_PATH(`after_json`, 'one', '$.generatedPassword', '$.salaryHourly');
