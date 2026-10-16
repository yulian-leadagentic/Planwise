-- =====================================================
-- HR Phase C · 20261016000000_hr_phase_c
--
-- Pairs with `docs/bm2/planwise-hr-module-spec.md` §10 (monthly roll-up
-- model) + §4 (engine logic). Additive: ONE new table, zero column
-- changes elsewhere. Nothing to backfill — the engine populates rows
-- on first `/hr/monthly/recompute` call.
--
-- Design decisions (resolved by Yulian, 2026-10-16):
--   • `monthly_attendance` is one row per (user, year, month).
--     `status` lifecycle: OPEN → APPROVED → LOCKED. LOCKED is a future
--     state for the Phase D consolidated accounting export; Phase C
--     never writes LOCKED.
--   • CASCADE on user_id — a de-provisioned employee loses their
--     attendance history with them (matches the AbsenceRecord cascade
--     from Phase B).
--   • SET NULL on approved_by_id — a deleted approver should not
--     retroactively nuke the approval signal; historical rows keep
--     `status=APPROVED` with a null approver.
--   • Precision: standard / actual / weighted / deviation at
--     DECIMAL(7,2) — more than enough for a month (worst case ~744h in
--     31 × 24, well under 99999.99). Sick / vacation days at
--     DECIMAL(5,2) because the AbsenceRecord unit=DAY allows 0.5
--     fractional days (per spec §3.4).
--
-- Written by hand to match the shadow-DB constraint of every BM2
-- migration. Railway's `prisma migrate deploy` on API boot applies it
-- after Yulian backs up staging (already done).
-- =====================================================

CREATE TABLE `monthly_attendance` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `user_id`           INT NOT NULL,
  `year`              INT NOT NULL,
  `month`             INT NOT NULL,
  `monthly_standard`  DECIMAL(7,2) NOT NULL,
  `actual_hours`      DECIMAL(7,2) NOT NULL,
  `weighted_hours`    DECIMAL(7,2) NOT NULL,
  `deviation`         DECIMAL(7,2) NOT NULL,
  `sick_days`         DECIMAL(5,2) NOT NULL,
  `vacation_days`     DECIMAL(5,2) NOT NULL,
  `days_office`       INT NOT NULL DEFAULT 0,
  `days_home`         INT NOT NULL DEFAULT 0,
  `days_site`         INT NOT NULL DEFAULT 0,
  `status`            ENUM('OPEN','APPROVED','LOCKED') NOT NULL DEFAULT 'OPEN',
  `approved_by_id`    INT NULL,
  `approved_at`       DATETIME(3) NULL,
  `computed_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_monthly_attendance_user_year_month` (`user_id`,`year`,`month`),
  INDEX `ix_monthly_attendance_year_month` (`year`,`month`),
  CONSTRAINT `fk_monthly_attendance_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_monthly_attendance_approvedby`
    FOREIGN KEY (`approved_by_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
