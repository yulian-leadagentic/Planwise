-- Migration: bp_phase3_business_partner_domains
--
-- BM2 Phase 3 (2026-08-13) — new table `business_partner_domains`.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 3 (also §4 of the
-- analysis + `bp-contacts-design.md` §1).
--
-- A BP may own several domains (office + secondary). The importer
-- dedups a company by domain first (per bp-contacts-design §3 rule 1),
-- then normalized name; multi-domain orgs are supported natively.
-- Personal / free-email domains never bind an org — that list is
-- maintained in `personal_email_domains` (Phase 4).
--
-- Written by hand — same shadow-DB constraint as the earlier BM2 / BM1
-- migrations.

CREATE TABLE `business_partner_domains` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `partner_id` INT          NOT NULL,
  `domain`     VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `bp_domain_unique_domain` (`domain`),
  INDEX      `bp_domain_partner_idx`  (`partner_id`),
  CONSTRAINT `bp_domain_partner_fk`
    FOREIGN KEY (`partner_id`)
    REFERENCES `business_partners`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
);
