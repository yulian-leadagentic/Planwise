-- Seed the "team_leader" Project Role Type and backfill every project's
-- Team Leader (Project.leader_id) as an active ProjectPartnerRole row.
--
-- Replaces the standalone Project.leader_id column with a relation so
-- the Team Leader is just another Project Role Type alongside BIM
-- Leader / Architect / etc. The legacy column is kept (nulled later
-- in M7) so any read path we miss still has the original value as a
-- fallback.
--
-- Idempotent — re-runs are no-ops thanks to NOT EXISTS guards.

-- 1. Seed the role type if absent.
INSERT INTO project_role_types
  (code, name, description, allowed_partner_kind, is_system, sort_order, created_at, updated_at)
SELECT
  'team_leader',
  'Team Leader',
  'The project''s lead engineer / project manager. Replaces the legacy Project.leader_id column.',
  'person',
  TRUE,
  0,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1 FROM project_role_types WHERE code = 'team_leader'
);

-- 2. Backfill: every project with a leader_id becomes an active
--    ProjectPartnerRole on the team_leader role. Maps users to their
--    linked BusinessPartner (party_id on ProjectPartnerRole references
--    business_partners.id, not users.id). Users without a linked BP
--    are silently skipped — they show as "(no leader)" until the
--    user_id <-> BP link is established.
INSERT INTO project_partner_roles
  (project_id, party_id, role_id, is_primary, valid_from, valid_to, status, created_at, updated_at)
SELECT
  p.id,
  u.business_partner_id,
  (SELECT id FROM project_role_types WHERE code = 'team_leader' LIMIT 1),
  TRUE,
  CURRENT_TIMESTAMP(3),
  '9999-12-31 00:00:00',
  'active',
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM projects p
INNER JOIN users u ON u.id = p.leader_id
WHERE p.leader_id IS NOT NULL
  AND u.business_partner_id IS NOT NULL
  AND p.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM project_partner_roles ppr
    INNER JOIN project_role_types prt ON prt.id = ppr.role_id
    WHERE ppr.project_id = p.id
      AND prt.code = 'team_leader'
      AND ppr.status = 'active'
  );
