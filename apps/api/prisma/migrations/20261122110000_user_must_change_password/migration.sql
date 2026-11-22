-- Permissions round 3 (2026-11-22) — forced password change on first
-- login, and hashed forgot-password secrets.
--
-- 1) users.must_change_password — set when someone else chose the
--    password (Admin/HR create, Admin reset of another user's password,
--    data import); cleared when the user sets his own. Existing users
--    stay false (default), so nobody is locked out by this deploy.
ALTER TABLE `users`
  ADD COLUMN `must_change_password` BOOLEAN NOT NULL DEFAULT false;

-- 2) Forgot-password codes and reset tokens are now stored as HMAC-SHA256
--    hashes in `otp_code`, never in plain text. Clear any plain-text
--    value left from before (codes live 10 minutes and were never
--    e-mailed, so no real reset is interrupted).
UPDATE `users`
  SET `otp_code` = NULL,
      `otp_expires_at` = NULL,
      `otp_attempts` = 0
  WHERE `otp_code` IS NOT NULL;
