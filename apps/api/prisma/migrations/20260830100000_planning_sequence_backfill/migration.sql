-- BM2 QA-2 Commit 8 · Planning sequence order (Model B — drag-authoritative).
--
-- Model B is:
--   • `sort_order` (already-existing column on Task / ProjectDeliverable /
--     Zone) is the SOLE render-order key inside its container.
--   • A manual drag renumbers siblings — that persisted order overrides
--     date on every subsequent render (a dragged item stays put even if
--     its planned date shifts).
--   • Date order is used ONLY to SEED `sort_order` for the FIRST render
--     of a container (before any manual drag), so a brand-new project's
--     default view is chronological.
--
-- This migration is that one-time seeding pass. It walks each container
-- and writes `sort_order = ROW_NUMBER() * 1000` in date order. The 1000
-- gap gives the smart-insert-on-create logic (tasks.service.ts /
-- zones.service.ts / project-deliverables.service.ts) room to slot a
-- new row via midpoint arithmetic without renumbering neighbours.
--
-- Containers:
--   • Task                — per (project_id, IFNULL(zone_id, 0)).
--   • ProjectDeliverable  — per project_id.
--   • Zone                — per (project_id, IFNULL(parent_id, 0)).
--
-- Sort keys (all NULLS LAST, then id ASC for a stable tiebreak):
--   • Task                — estimated_start_date.
--   • ProjectDeliverable  — target_date.
--   • Zone                — created_at (zones carry no planning date).
--
-- Soft-deleted rows (deleted_at IS NOT NULL) are excluded so their stale
-- sortOrder never competes with live siblings after an undelete.
--
-- Idempotency note: Prisma runs each migration exactly once per DB (via
-- _prisma_migrations tracking), so a re-run in this database is not a
-- concern. Should this ever be replayed manually, the queries below are
-- deterministic under the same input rows — no ADD/DROP, only UPDATE.
--
-- Trade-off surfaced in the Phase-1 audit: any pre-existing manual
-- drag order on the three tables is overwritten by this seed. That is
-- intentional — before Model B nothing consistently persisted user drag
-- intent across the whole planning surface, so we reset once to
-- "chronological by date" and let users re-drag on top.

-- 1. Tasks — one sequence per (project, zone). NULL zone_id (project-
-- root tasks) get their own bucket via IFNULL(..., 0). We coerce
-- estimated_start_date NULLs to the tail with `IS NULL` first in ORDER
-- BY (MySQL sorts FALSE < TRUE, so NULL rows land last).
UPDATE `tasks` t
JOIN (
  SELECT `id`,
    ROW_NUMBER() OVER (
      PARTITION BY `project_id`, IFNULL(`zone_id`, 0)
      ORDER BY `estimated_start_date` IS NULL, `estimated_start_date` ASC, `id` ASC
    ) * 1000 AS new_sort_order
  FROM `tasks`
  WHERE `deleted_at` IS NULL
) x ON x.`id` = t.`id`
SET t.`sort_order` = x.new_sort_order;

-- 2. Project deliverables — one sequence per project. target_date is the
-- Deliverable Planning "N months from base" value snapped to a date.
UPDATE `project_deliverables` pd
JOIN (
  SELECT `id`,
    ROW_NUMBER() OVER (
      PARTITION BY `project_id`
      ORDER BY `target_date` IS NULL, `target_date` ASC, `id` ASC
    ) * 1000 AS new_sort_order
  FROM `project_deliverables`
  WHERE `deleted_at` IS NULL
) x ON x.`id` = pd.`id`
SET pd.`sort_order` = x.new_sort_order;

-- 3. Zones — one sequence per (project, parent_zone). Zones carry no
-- planning date, so we fall back to created_at (creation order matches
-- the PM's mental "I built them in this order" expectation on a fresh
-- project). Root zones (NULL parent_id) get their own bucket.
UPDATE `zones` z
JOIN (
  SELECT `id`,
    ROW_NUMBER() OVER (
      PARTITION BY `project_id`, IFNULL(`parent_id`, 0)
      ORDER BY `created_at` ASC, `id` ASC
    ) * 1000 AS new_sort_order
  FROM `zones`
  WHERE `deleted_at` IS NULL
) x ON x.`id` = z.`id`
SET z.`sort_order` = x.new_sort_order;
