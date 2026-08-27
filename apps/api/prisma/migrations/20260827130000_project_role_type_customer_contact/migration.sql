-- Migration: project_role_type_customer_contact
--
-- BM2 QA-2 · Commit 3 · PR-026 (2026-08-27) — project-scoped customer
-- contact list. Pairs with `docs/bm2/bm2-qa2-cc-specs.md` Commit 3
-- (Yulian's locked design 2026-08-27).
--
-- The previous behaviour on the Team tab surfaced EVERY person with a
-- `worker_of` / `contact_of_customer` edge to the project's customer
-- org, on EVERY project of that customer. Yulian's locked design
-- moves customer contacts onto a project-scoped `project_partner_role`
-- row so a contact only appears on projects it was explicitly
-- attached to. The row shape:
--
--   party            = the customer organisation
--   role             = 'customer_contact' (this seed)
--   contactParty     = the person who is the customer contact
--
-- This mirrors the existing "org participant + contact person"
-- convention already read by getAssigneeCandidates (an org party with
-- a contact_party person). Multi-employer is preserved: the row is
-- keyed by (project, org, person) — a person can be attached to
-- several projects via several employer orgs independently of their
-- global `worker_of` graph.
--
-- Clean start: NO backfill of the org-wide `partner_relationships`
-- edges into `project_partner_roles`. Existing worker_of /
-- contact_of_customer edges STAY as the picker's candidate source
-- (i.e. "who could be a customer contact"). A project's customer-
-- contact list is empty until contacts are explicitly (re-)attached
-- via the new picker flow. This is intended and matches the spec.
--
-- Field choices:
--   allowed_partner_kind = 'organization'  — the row's `party` IS the
--                                            customer org. The person
--                                            lives on `contact_party_id`,
--                                            not on `party_id`.
--   is_primary_required  = FALSE           — many customer contacts per
--                                            project; no single primary.
--   requires_contact_person = TRUE         — the whole reason for this
--                                            role type is that the party
--                                            (org) has a specific person
--                                            attached; the add flow must
--                                            collect that person picker.
--   is_system            = TRUE            — protect the row from admin
--                                            deletion (rename allowed).
--   sort_order           = 15              — sits between 'customer' (10)
--                                            and 'supplier' (20).
--
-- Idempotent via `ON DUPLICATE KEY UPDATE` on the unique `code` — a
-- re-run always converges canonical values. Written by hand — same
-- shadow-DB constraint as the earlier BM2 migrations.

INSERT INTO `project_role_types`
  (`code`,              `name`,              `description`,                                                                                                     `allowed_partner_kind`, `required_partner_role_code`, `is_primary_required`, `requires_contact_person`, `sort_order`, `is_system`, `created_at`,  `updated_at`)
VALUES
  ('customer_contact', 'Customer Contact', 'Person contact attached to this project via the customer organisation; project-scoped (not org-wide).',          'organization',         NULL,                          FALSE,                 TRUE,                      15,           TRUE,        NOW(3),        NOW(3))
ON DUPLICATE KEY UPDATE
  `name`                    = VALUES(`name`),
  `description`             = VALUES(`description`),
  `allowed_partner_kind`    = VALUES(`allowed_partner_kind`),
  `is_primary_required`     = VALUES(`is_primary_required`),
  `requires_contact_person` = VALUES(`requires_contact_person`),
  `sort_order`              = VALUES(`sort_order`),
  `is_system`               = TRUE,
  `updated_at`              = NOW(3);
