-- Migration: lag_reasons_catalog
--
-- B1 (QA-FIX-ALL 2026-11-04) — pairs with
-- `docs/bm2/planwise-QA-FIX-ALL-2026-11-04.md` §B1. Introduces the
-- managed catalog that backs the dependency-lag "reason" picker.
--
-- Additive + safe:
--   • New `lag_reasons` catalog (name + optional Hebrew + sortOrder +
--     isActive). Seed lives in `prisma/seed.ts` — this migration is
--     DDL-only so staging can replay it idempotently.
--   • NO foreign key from `task_dependencies.reason` or
--     `template_task_dependencies.reason`. The relation is INTENTIONALLY
--     LOOSE per the work order — a stale catalog name on a legacy row
--     keeps rendering after an admin deletes the matching catalog row.
--
-- Composite index `(is_active, sort_order, name)` matches the
-- `GET /lookups/lag-reasons` query (WHERE is_active = 1 ORDER BY
-- sort_order ASC, name ASC) so the public lookup read is covered.

CREATE TABLE `lag_reasons` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(120) NOT NULL,
  `nameHe`     VARCHAR(120)     NULL,
  `sortOrder`  INT          NOT NULL DEFAULT 0,
  `isActive`   BOOLEAN      NOT NULL DEFAULT TRUE,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `lag_reasons_name_key` (`name`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE INDEX `lag_reasons_isActive_sortOrder_name_idx`
  ON `lag_reasons` (`isActive`, `sortOrder`, `name`);
