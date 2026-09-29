-- Migration: additional_emails
--
-- QA4 R2 IMP-9 (2026-09-29) — pairs with `docs/bm2/qa4-import-preview.md`
-- Round-2 IMP-9. Additive + reversible: the current
-- `business_partners.email` column stays as the primary email; this
-- table carries every additional address (personal alt-email + generic
-- office mailbox routed to the org).
--
-- Design:
--   • Unique per (business_partner_id, email) — so we never stack
--     duplicate rows for the same partner.
--   • email is NOT globally unique — a shared `office@` on multiple
--     franchisee orgs is a real case; the primary column already has
--     its own dedup story via BusinessPartnerDomain.
--   • is_primary mirrors whether the row matches the BP's primary
--     column, letting downstream readers work off just this table
--     when convenient. Kept in sync at write time by the importer;
--     no DB-level trigger (would need a shadow-DB compatible pass).
--   • CASCADE on delete: removing the parent BP removes its email
--     history in the same statement, matching how domains behave.
--
-- Written by hand (same shadow-DB constraint as the other BM2
-- migrations). No data backfill — new rows populate on-demand.

CREATE TABLE `business_partner_emails` (
  `id`                   INT              NOT NULL AUTO_INCREMENT,
  `business_partner_id`  INT              NOT NULL,
  `email`                VARCHAR(255)     NOT NULL,
  `is_primary`           BOOLEAN          NOT NULL DEFAULT FALSE,
  `created_at`           DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_bp_email_bp_email` (`business_partner_id`, `email`),
  KEY `bp_emails_bp_idx`    (`business_partner_id`),
  KEY `bp_emails_email_idx` (`email`),

  CONSTRAINT `fk_bp_email_partner`
    FOREIGN KEY (`business_partner_id`)
    REFERENCES `business_partners` (`id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
