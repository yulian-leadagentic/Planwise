-- BM2 QA-2 Commit 5 · PR-021 — remove service-type entries from ProjectType.
--
-- The `project_types` table was seeded with "BIM Coordination", "BIM
-- Management" and "MEP Coordination" which are conceptually *service* types
-- (they belong on service/deliverable, not project category). The Category
-- select on the New-Project form pulls from this table, so those names
-- showed up as project categories — the bug PR-021 fixes.
--
-- Safety: `project.project_type_id` is a required FK, so we only delete a
-- ProjectType row when NO project references it. Legacy projects that
-- happen to point at one of these bad rows keep their pointer; an admin
-- can reassign them from Admin → Project Types (which already supports
-- edit + delete). Fresh installs get the pruned seed (see prisma/seed.ts).

DELETE FROM `project_types`
WHERE `name` IN ('BIM Coordination', 'BIM Management', 'MEP Coordination')
  AND `id` NOT IN (SELECT DISTINCT `project_type_id` FROM `projects`);
