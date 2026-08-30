-- Migration: bp_phase4_personal_domains_non_exclusive
--
-- BM2 QA-2 Commit 12 (2026-08-30) — allow personal / free-email domains
-- to be attached to an org WITHOUT breaking the exclusivity guarantee
-- that ordinary corporate domains still enjoy.
--
-- Pairs with `docs/bm2/bm2-qa2-cc-specs.md` §Commit 12 (B8).
--
-- Design:
--   • Extend the `personal_email_domains` catalog seed from 11 → 29
--     (Israel-focused set from the spec). Idempotent via INSERT IGNORE.
--   • Add `is_personal` BOOLEAN to `business_partner_domains`. Written
--     at insert time by the service, once, from the catalog + fallback
--     set — downstream reads just consult the flag.
--   • Backfill: mark existing rows whose domain matches the (now-
--     complete) catalog. Retroactive only; no rows are removed.
--   • Relax the global `@@unique([domain])` exclusivity so that a
--     personal domain can appear on many orgs. A MySQL 8 functional
--     unique index (`UNIQUE INDEX ON (IF(is_personal=0, domain, NULL))`)
--     enforces exclusivity ONLY for is_personal=FALSE rows. Personal
--     rows all map to NULL in the index, and NULLs are treated as
--     distinct → any number of orgs may claim gmail.com.
--   • ALSO add a compound `(partner_id, domain)` unique so the same org
--     cannot list the same domain twice (applies to personal AND
--     non-personal rows). Different orgs can still share a personal
--     domain — the functional index above lets them, and this compound
--     one keyed by partner_id doesn't block cross-org duplicates.
--
-- Written by hand — same shadow-DB constraint as the earlier BM2
-- migrations (the `amec` user lacks CREATE-database).
--
-- Pre-flight checks:
--   $ grep -rn "P2002" apps/api/src/modules/business-partners →
--     one hit at business-partners.service#addDomain. That path stays
--     functional: the service still catches P2002, but from this
--     migration on it can only fire on (a) same-org duplicate — good,
--     the compound unique — or (b) a non-personal domain already
--     claimed elsewhere — also good, the functional index. The service
--     is updated in the same commit to pre-filter personal rows to a
--     friendly "no exclusivity" path.
--   $ grep -rn "bp_domain_unique_domain" → 0 hits outside this migration
--     directory; safe to drop.

-- ─── 1. Extend the personal_email_domains seed (11 → 29) ─────────────
--
-- INSERT IGNORE so re-running the migration is safe. The 11 original
-- rows (system=TRUE, from the Phase 4 migration) are untouched by the
-- unique-key hit; only the 18 additions land.
INSERT IGNORE INTO `personal_email_domains` (`domain`, `description`, `is_system`, `updated_at`) VALUES
  ('googlemail.com',   'Google free mail (legacy alias)', TRUE, NOW(3)),
  ('yahoo.co.il',      'Yahoo (IL)',                       TRUE, NOW(3)),
  ('ymail.com',        'Yahoo alias',                      TRUE, NOW(3)),
  ('hotmail.co.il',    'Microsoft legacy (IL)',            TRUE, NOW(3)),
  ('outlook.co.il',    'Microsoft (IL)',                   TRUE, NOW(3)),
  ('msn.com',          'Microsoft legacy',                 TRUE, NOW(3)),
  ('gmx.com',          'GMX free mail',                    TRUE, NOW(3)),
  ('yandex.com',       'Yandex free mail',                 TRUE, NOW(3)),
  ('mail.com',         'Mail.com free mail',               TRUE, NOW(3)),
  ('walla.com',        'Walla! (.com)',                    TRUE, NOW(3)),
  ('nana10.co.il',     'Nana10 (IL)',                      TRUE, NOW(3)),
  ('nana.co.il',       'Nana (IL)',                        TRUE, NOW(3)),
  ('012.net.il',       '012 (IL ISP webmail)',             TRUE, NOW(3)),
  ('013.net',          '013 (IL ISP webmail)',             TRUE, NOW(3)),
  ('bezeqint.net',     'Bezeq International (IL)',         TRUE, NOW(3)),
  ('netvision.net.il', 'Netvision (IL ISP webmail)',       TRUE, NOW(3)),
  ('zahav.net.il',     'Zahav (IL ISP webmail)',           TRUE, NOW(3)),
  ('actcom.net.il',    'Actcom (IL ISP webmail)',          TRUE, NOW(3)),
  ('barak.net.il',     'Barak (IL ISP webmail)',           TRUE, NOW(3));

-- ─── 2. Add is_personal column ───────────────────────────────────────
--
-- Default FALSE — corporate domains are the common case, and the
-- service overrides at write time when the incoming domain is in the
-- catalog. Existing rows keep FALSE until the backfill step below
-- promotes the ones that happen to be personal.
ALTER TABLE `business_partner_domains`
  ADD COLUMN `is_personal` BOOLEAN NOT NULL DEFAULT FALSE AFTER `domain`;

-- ─── 3. Backfill existing rows against the (now complete) catalog ────
--
-- Retroactive marker only. No row is deleted; two orgs that legally
-- shared a "gmail.com" style row (impossible under the old unique
-- guard, but defensive) would both flip to is_personal=TRUE and then
-- coexist via the new functional index.
UPDATE `business_partner_domains` bpd
  JOIN `personal_email_domains` ped ON ped.`domain` = bpd.`domain`
   SET bpd.`is_personal` = TRUE;

-- ─── 4. Swap the exclusivity index ────────────────────────────────────
--
-- Old: UNIQUE(domain) — one org globally.
-- New: UNIQUE(IF(is_personal=0, domain, NULL)) — one org for corporate
--      domains only; personal domains yield NULL and NULLs are distinct
--      in a MySQL UNIQUE INDEX, so any number of rows can carry the
--      same personal domain.
-- Also add a compound (partner_id, domain) unique so ONE org can list
-- ONE domain at most once (applies to personal + non-personal).
DROP INDEX `bp_domain_unique_domain` ON `business_partner_domains`;

CREATE UNIQUE INDEX `ux_bp_domain_partner_domain`
  ON `business_partner_domains` (`partner_id`, `domain`);

CREATE UNIQUE INDEX `ux_bp_domain_non_personal_domain`
  ON `business_partner_domains` ((IF(`is_personal` = 0, `domain`, NULL)));
