-- PR-069 (QA6, 2026-11-25) — separate project phases from services in the
-- `phases` table (the app's "Service" catalog).
--
-- phases.kind      — 'service' (default, every existing row) or 'phase'
--                    (a project lifecycle phase the v8 seed saved here:
--                    Pre-Design, Design, Construction, AFC, Handover,
--                    Maintenance, תכנון מפורט / סופי / לביצוע). Phase rows
--                    stay readable for whatever points at them and are
--                    left out of the Service pickers.
-- phases.is_active — false = merged into another row or retired; hidden
--                    from pickers, never deleted while referenced.
--
-- Additive, no data change: every row stays an active service until the
-- reviewed POST /admin/backfills/qa6-service-phase-cleanup run marks it
-- (dry-run first, then only the approved ids).
ALTER TABLE `phases`
  ADD COLUMN `kind` ENUM('service', 'phase') NOT NULL DEFAULT 'service' AFTER `sort_order`,
  ADD COLUMN `is_active` BOOLEAN NOT NULL DEFAULT true AFTER `kind`;
