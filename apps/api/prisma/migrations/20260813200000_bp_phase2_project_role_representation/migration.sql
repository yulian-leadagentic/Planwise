-- Migration: bp_phase2_project_role_representation
--
-- BM2 Phase 2 (2026-08-13) — schema add.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 2.
--
-- Adds two optional self-FKs to `project_partner_roles`:
--   • contact_party_id      → the PERSON who is the contact when this
--                              row's party is an ORG. Powers the
--                              "Org X on project P, contact = Person C"
--                              relation.
--   • on_behalf_of_party_id → the ORG a PERSON represents on THIS
--                              project. Pins the employer per-project
--                              for freelancers / multi-employer people.
-- Both cascade SET NULL if the referenced party is deleted, so a
-- party removal doesn't cascade-delete the participation row.
--
-- Written by hand — same shadow-DB constraint as the earlier BM2/BM1
-- migrations.

ALTER TABLE `project_partner_roles`
  ADD COLUMN `contact_party_id`      INT NULL AFTER `title_in_project`,
  ADD COLUMN `on_behalf_of_party_id` INT NULL AFTER `contact_party_id`;

ALTER TABLE `project_partner_roles`
  ADD CONSTRAINT `ppr_contact_party_fk`
    FOREIGN KEY (`contact_party_id`)
    REFERENCES `business_partners`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `ppr_on_behalf_of_fk`
    FOREIGN KEY (`on_behalf_of_party_id`)
    REFERENCES `business_partners`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `ppr_contact_party_idx`  ON `project_partner_roles` (`contact_party_id`);
CREATE INDEX `ppr_on_behalf_of_idx`   ON `project_partner_roles` (`on_behalf_of_party_id`);
