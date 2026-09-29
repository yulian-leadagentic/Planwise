-- Migration: seed_positions
--
-- QA4 JT-3 (2026-09-29) — seed the four Yulian-approved Position
-- catalog rows so the drawer + People edit picker have real options
-- to choose from as soon as this migration lands, WITHOUT waiting on
-- JT-4's person-link data move.
--
-- Split out from JT-4's admin backfill because JT-3's DoD depends on
-- being able to open an employee and set Position = VP on staging.
-- Running JT-4 today would move person-links (removing team_leader
-- gate eligibility from 4 CEOs before Yulian has re-tested); this
-- migration touches only the catalog, so it's safe on its own.
--
-- Idempotent via `INSERT ... ON DUPLICATE KEY UPDATE` — the `code`
-- column carries a UNIQUE, so re-running (or JT-4 running later)
-- upserts to a no-op instead of erroring. JT-4's own upsert step
-- writes the same rows and hits the same unique so both paths
-- converge.
--
-- Written by hand for shadow-DB parity with the other BM2 migrations.
-- No FK writes; no partner rows touched.

INSERT INTO `positions` (`code`, `name`, `name_he`, `sort_order`, `is_active`, `created_at`, `updated_at`) VALUES
  ('ceo',        'CEO',        'מנכ״ל',           10, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('vp',         'VP',         'סמנכ״ל',          20, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('hr-manager', 'HR manager', 'מנהל משאבי אנוש', 30, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('finance',    'Finance',    'כספים',           40, TRUE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  `name`       = VALUES(`name`),
  `name_he`    = VALUES(`name_he`),
  `sort_order` = VALUES(`sort_order`),
  `is_active`  = TRUE,
  `updated_at` = CURRENT_TIMESTAMP(3);
