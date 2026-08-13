-- Migration: bp_phase4_personal_email_domains
--
-- BM2 Phase 4 (2026-08-13) — personal / free-email domain catalog.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 4.
--
-- Small admin-managed list. When the import dedup encounters an email
-- whose domain is in this catalog, the row does NOT bind an
-- organization (per rule 2 of `bp-contacts-design.md` §3 — personal
-- domains route to conflict resolution).
--
-- Seeded with 11 common free-mail hosts (matches the fallback set
-- shipped in business-partners.service.ts to keep behavior consistent
-- pre- and post-catalog).
--
-- Written by hand — same shadow-DB constraint as the earlier BM2 / BM1
-- migrations.

CREATE TABLE `personal_email_domains` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `domain`      VARCHAR(255) NOT NULL,
  `description` VARCHAR(255) NULL,
  `is_system`   BOOLEAN      NOT NULL DEFAULT FALSE,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `personal_email_domains_domain_key` (`domain`)
);

INSERT INTO `personal_email_domains` (`domain`, `description`, `is_system`, `updated_at`) VALUES
  ('gmail.com',       'Google free mail',        TRUE, NOW(3)),
  ('yahoo.com',       'Yahoo free mail',         TRUE, NOW(3)),
  ('outlook.com',     'Microsoft free mail',     TRUE, NOW(3)),
  ('hotmail.com',     'Microsoft legacy',        TRUE, NOW(3)),
  ('icloud.com',      'Apple iCloud',            TRUE, NOW(3)),
  ('walla.co.il',     'Walla! (IL)',             TRUE, NOW(3)),
  ('live.com',        'Microsoft legacy',        TRUE, NOW(3)),
  ('me.com',          'Apple legacy',            TRUE, NOW(3)),
  ('aol.com',         'AOL',                     TRUE, NOW(3)),
  ('proton.me',       'Proton Mail',             TRUE, NOW(3)),
  ('protonmail.com',  'Proton Mail legacy',      TRUE, NOW(3));
