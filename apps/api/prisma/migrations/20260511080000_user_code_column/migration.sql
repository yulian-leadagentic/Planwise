-- M1.1c — User business code (employee number).
--
-- Allocated from the EMPLOYEE entity-kind's number range at user create.
-- Nullable so existing users aren't blocked; future creates fill it in
-- automatically (auto mode) or require an entered value (manual/external).

ALTER TABLE `users`
  ADD COLUMN `code` VARCHAR(50) NULL,
  ADD UNIQUE INDEX `users_code_key` (`code`);
