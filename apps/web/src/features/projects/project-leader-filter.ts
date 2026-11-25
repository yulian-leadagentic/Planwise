/**
 * PR-066 (QA6 package 8): Team Leader filter on the project list.
 *
 * A project's team leaders come from two places that the API keeps in
 * sync but that can still differ on older rows:
 *   - `project.leader` (legacy `Project.leaderId`, what Group by uses)
 *   - active `partnerRoles` on the `team_leader` Project Role Type
 * Both are folded into one key set, keyed by user id when the party is a
 * user (`u:<userId>`) and by party id otherwise (`p:<partyId>`), so the
 * same person never shows up twice.
 *
 * Filter semantics: empty selection = no filter. Otherwise a project
 * passes when ANY of its leaders is selected, or when it has no leader
 * and the "No team leader" bucket is selected.
 */

export const NO_TEAM_LEADER_KEY = '__none__';
export const NO_TEAM_LEADER_LABEL = 'No team leader';

export interface TeamLeaderRef {
  key: string;
  label: string;
}

interface ProjectLeaderShape {
  leader?: { id?: number | null; firstName?: string | null; lastName?: string | null } | null;
  partnerRoles?: Array<{
    roleId?: number | null;
    party?: {
      id?: number | null;
      displayName?: string | null;
      user?: { id?: number | null } | null;
    } | null;
  } | null> | null;
}

/** Distinct team leaders of one project (legacy leader first). */
export function projectTeamLeaders(
  project: ProjectLeaderShape | null | undefined,
  teamLeaderRoleId: number | null | undefined,
): TeamLeaderRef[] {
  if (!project) return [];
  const out = new Map<string, string>();
  const leader = project.leader;
  if (leader?.id != null) {
    const label = `${leader.firstName ?? ''} ${leader.lastName ?? ''}`.trim() || `User #${leader.id}`;
    out.set(`u:${leader.id}`, label);
  }
  if (teamLeaderRoleId != null) {
    for (const r of project.partnerRoles ?? []) {
      if (!r || r.roleId !== teamLeaderRoleId || !r.party) continue;
      const userId = r.party.user?.id;
      const key = userId != null ? `u:${userId}` : r.party.id != null ? `p:${r.party.id}` : null;
      if (!key || out.has(key)) continue;
      out.set(key, r.party.displayName?.trim() || '(unnamed)');
    }
  }
  return Array.from(out, ([key, label]) => ({ key, label }));
}

/**
 * Dropdown options: every leader present on the loaded projects, sorted
 * by name, then "No team leader" when some project has none. Selected
 * keys that are no longer on screen (persisted from an earlier session,
 * or hidden by search) stay listed so they can still be unticked;
 * `labelForMissing` names them (e.g. from the active-users list).
 */
export function teamLeaderFilterOptions(
  projects: ReadonlyArray<ProjectLeaderShape>,
  teamLeaderRoleId: number | null | undefined,
  selectedKeys: ReadonlyArray<string> = [],
  labelForMissing?: (key: string) => string | null | undefined,
): TeamLeaderRef[] {
  const byKey = new Map<string, string>();
  let anyWithout = false;
  for (const p of projects) {
    const leaders = projectTeamLeaders(p, teamLeaderRoleId);
    if (leaders.length === 0) anyWithout = true;
    for (const l of leaders) if (!byKey.has(l.key)) byKey.set(l.key, l.label);
  }
  for (const key of selectedKeys) {
    if (key === NO_TEAM_LEADER_KEY || byKey.has(key)) continue;
    byKey.set(key, labelForMissing?.(key) || 'Unknown leader');
  }
  const opts = Array.from(byKey, ([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  if (anyWithout || selectedKeys.includes(NO_TEAM_LEADER_KEY)) {
    opts.push({ key: NO_TEAM_LEADER_KEY, label: NO_TEAM_LEADER_LABEL });
  }
  return opts;
}

/** Filter predicate. Empty selection lets every project through. */
export function matchesTeamLeaderFilter(
  project: ProjectLeaderShape,
  selectedKeys: ReadonlyArray<string>,
  teamLeaderRoleId: number | null | undefined,
): boolean {
  if (selectedKeys.length === 0) return true;
  const leaders = projectTeamLeaders(project, teamLeaderRoleId);
  if (leaders.length === 0) return selectedKeys.includes(NO_TEAM_LEADER_KEY);
  return leaders.some((l) => selectedKeys.includes(l.key));
}

/** User id behind a `u:<id>` key, or null for party / bucket keys. */
export function userIdFromLeaderKey(key: string): number | null {
  const m = /^u:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}
