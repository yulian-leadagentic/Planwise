-- PR-069 (QA6, 2026-11-26) - let the Service cleanup retire a duplicate
-- row of the `service_types` table ("BIM Coordination BIM" next to
-- "BIM Coordination") without deleting it.
--
-- service_types.is_active - false = merged into another row or retired by
--                           the reviewed POST /admin/backfills/
--                           qa6-service-phase-cleanup run; left out of
--                           GET /service-types, never deleted.
--
-- Additive, no data change: every row stays active until a reviewed run
-- (dry-run first, then only the approved rows) merges or retires it.
ALTER TABLE `service_types`
  ADD COLUMN `is_active` BOOLEAN NOT NULL DEFAULT true AFTER `sort_order`;
