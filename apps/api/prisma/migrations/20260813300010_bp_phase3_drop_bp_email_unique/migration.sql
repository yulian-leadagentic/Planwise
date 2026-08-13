-- Migration: bp_phase3_drop_bp_email_unique
--
-- BM2 Phase 3 (2026-08-13) — relax email uniqueness on business_partners.
-- Pairs with `docs/bm2/bp-model-refactor.md` Phase 3.
--
-- Real data has multiple contacts sharing an office inbox (analysis
-- §9.1); the pre-existing UNIQUE constraint on email surfaces as a
-- P2002 the moment the second person imports. Drop the UNIQUE INDEX
-- and replace it with a plain INDEX so lookups by email stay fast.
--
-- Identity for a BP is now the row + its owned domains
-- (`business_partner_domains`) + normalized name — dedup is enforced
-- in importer logic, not by the DB.
--
-- Pre-flight check (per the spec — "search for catches on the unique
-- error first"):
--   $ grep -rn "P2002" apps/api/src → 6 hits, none targeting
--     BusinessPartner.email specifically. business-partners.service pre-
--     queries for a dup and returns a friendly ConflictException; the
--     query path stays functional after the constraint is removed since
--     it uses the (now non-unique) index.
--
-- Written by hand — same shadow-DB constraint as the earlier
-- migrations.

DROP INDEX `business_partners_email_key` ON `business_partners`;
CREATE INDEX `business_partners_email_idx` ON `business_partners` (`email`);
