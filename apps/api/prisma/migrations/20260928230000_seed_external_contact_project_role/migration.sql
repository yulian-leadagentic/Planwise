-- Migration: seed_external_contact_project_role
--
-- QA4 D9 (2026-09-28) — pairs with `docs/bm2/qa4-round1.md` §D9 and
-- the project Team-tab "Import contacts (Excel)" entry point.
--
-- The contacts-import commit path (`commit.service.ts`
-- `pickProjectRoleId`) falls back to the first ProjectRoleType with
-- `code IN ('contact', 'external_contact', 'consultant')` when the
-- caller doesn't pin an explicit role. Before this migration NONE of
-- those codes existed in `project_role_types` — the only close
-- neighbour was `customer_contact`, which is specifically for people
-- who work at the project's customer org (`requires_contact_person =
-- TRUE`). Imports coming from a developer stakeholder sheet contain
-- consultants, planners, suppliers etc. that are NOT attached to the
-- customer org, so `customer_contact` is the wrong bucket.
--
-- Seed `external_contact` as a generic project stakeholder role:
--   allowed_partner_kind    = 'any'   — person or org
--   required_partner_role_code = NULL — no gate on global BP typing
--   is_primary_required     = FALSE   — many stakeholders per project
--   requires_contact_person = FALSE   — the row itself IS the person /
--                                       org; no separate contact needed
--   is_system               = TRUE    — protect the row from admin
--                                       deletion (rename allowed)
--   sort_order              = 25      — sits after supplier (20)
--
-- Idempotent via `ON DUPLICATE KEY UPDATE` on the unique `code` — a
-- re-run always converges canonical values. `contact` and
-- `consultant` are intentionally NOT seeded here: the fallback list
-- prefers `contact` first, but `external_contact` reads better in
-- the UI and covers the same intent; keeping the shorter code free
-- so future work can repurpose it if needed. Written by hand — same
-- shadow-DB constraint as the earlier BM2 migrations.

INSERT INTO `project_role_types`
  (`code`,              `name`,              `description`,                                                                                        `allowed_partner_kind`, `required_partner_role_code`, `is_primary_required`, `requires_contact_person`, `sort_order`, `is_system`, `created_at`, `updated_at`)
VALUES
  ('external_contact', 'External Contact', 'Third-party stakeholder on the project (consultant, planner, supplier contact, etc.); not employee-of-record.', 'any',                  NULL,                          FALSE,                 FALSE,                     25,           TRUE,        NOW(3),       NOW(3))
ON DUPLICATE KEY UPDATE
  `name`                    = VALUES(`name`),
  `description`             = VALUES(`description`),
  `allowed_partner_kind`    = VALUES(`allowed_partner_kind`),
  `is_primary_required`     = VALUES(`is_primary_required`),
  `requires_contact_person` = VALUES(`requires_contact_person`),
  `sort_order`              = VALUES(`sort_order`),
  `is_system`               = TRUE,
  `updated_at`              = NOW(3);
