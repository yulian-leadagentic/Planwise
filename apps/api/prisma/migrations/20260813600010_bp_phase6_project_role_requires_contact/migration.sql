-- Migration: bp_phase6_project_role_requires_contact
--
-- BM2 Phase 6 (2026-08-13) — schema add on project_role_types.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 6 · admin surfaces.
--
-- Adds `requires_contact_person` — a UI hint driving the contact-person
-- picker in the operational add-participant flow (which consumes
-- `project_partner_roles.contact_party_id`, added by
-- 20260813200000_bp_phase2_project_role_representation). The backend
-- still accepts contactPartyId on ANY role; this flag only tells the
-- UI to REQUIRE the picker for org-participants of this role type.
--
-- Written by hand — same shadow-DB constraint as the earlier BM2
-- migrations.

ALTER TABLE `project_role_types`
  ADD COLUMN `requires_contact_person` BOOLEAN NOT NULL DEFAULT FALSE AFTER `is_primary_required`;
