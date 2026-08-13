-- Migration: bp_phase6_role_types_seed
--
-- BM2 Phase 6 (2026-08-13) — idempotent seed of the BP role-type set.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 6.
--
-- Ensures the five BP typing roles exist:
--   client · developer · supervision · partner · consultant
-- `consultant` already exists from 20260427000000_business_partners.
-- The other four are new. All are marked `is_system=TRUE` so the admin
-- UI protects them from deletion (rename allowed).
--
-- ON DUPLICATE KEY UPDATE keeps `is_system=TRUE` and refreshes `name /
-- description` so a re-run always converges the canonical values.
-- `applies_to_kind` = 'organization' for client / developer / partner
-- (the four "org type" classifiers per the analysis §6); 'any' for
-- supervision / consultant since a supervision or consultant party
-- can plausibly be a person or an organization.
--
-- Written by hand — same shadow-DB constraint as the earlier BM2
-- migrations.

INSERT INTO `partner_role_types`
  (`code`, `name`, `description`, `applies_to_kind`, `sort_order`, `is_system`, `created_at`, `updated_at`)
VALUES
  ('client',      'Client',      'The paying party for a project (analogous to the SAP customer role).', 'organization', 10, TRUE, NOW(3), NOW(3)),
  ('developer',   'Developer',   'Party responsible for developing / building the project.',              'organization', 11, TRUE, NOW(3), NOW(3)),
  ('supervision', 'Supervision', 'Party overseeing / auditing the project (design supervision, safety supervision, …).', 'any', 12, TRUE, NOW(3), NOW(3)),
  ('partner',     'Partner',     'A firm or entity Planwise partners with on projects.',                  'organization', 13, TRUE, NOW(3), NOW(3)),
  ('consultant',  'Consultant',  'External advisor engaged on a per-project basis.',                      'any',           14, TRUE, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `name`            = VALUES(`name`),
  `description`     = VALUES(`description`),
  `applies_to_kind` = VALUES(`applies_to_kind`),
  `sort_order`      = VALUES(`sort_order`),
  `is_system`       = TRUE,
  `updated_at`      = NOW(3);
