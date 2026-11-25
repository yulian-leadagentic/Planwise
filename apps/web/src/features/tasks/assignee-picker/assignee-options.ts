import type { AssigneeCandidate } from '@/api/projects.api';

/**
 * QA6 package 1 (2026-11-25) — who a task assignee picker offers.
 *
 *   • By default only the project's Team (`/projects/:id/assignee-candidates`),
 *     internal employees only.
 *   • A leader / Admin (`canManage` from GET /projects/:id) may widen to
 *     every employee; picking someone outside the Team adds him to the
 *     Team as a participant (the server does it), so the row says so.
 *   • External contacts never appear (not even disabled).
 *
 * Pure so it is unit-tested (assignee-options.spec.ts) and shared by the
 * task drawer, the planning grid picker and its bulk-assign bar.
 */

export interface AssigneeOption {
  key: string;
  userId: number;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  role: string | null;
  discipline: string | null;
  /** False = not on the Team yet; assigning adds him to the Team. */
  onTeam: boolean;
}

/** A person row from GET /users (directory tier). */
export interface DirectoryUser {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  userType?: string | null;
  isActive?: boolean | null;
  position?: string | null;
  orgUnit?: { name?: string | null } | null;
}

/** Internal employee with an active account (same rule as the server). */
export function isInternalEmployee(u: Pick<DirectoryUser, 'userType' | 'isActive'>): boolean {
  return (u.userType === 'employee' || u.userType === 'both') && u.isActive !== false;
}

const fullName = (first?: string | null, last?: string | null) => `${first ?? ''} ${last ?? ''}`.trim();

/** Team rows the server marks assignable (employees); externals dropped. */
export function teamOptions(candidates: AssigneeCandidate[]): AssigneeOption[] {
  return candidates
    .filter((c) => c.canAssign && c.userId != null && c.isEmployee !== false)
    .map((c) => ({
      key: `t:${c.userId}`,
      userId: c.userId as number,
      firstName: c.firstName,
      lastName: c.lastName,
      displayName: fullName(c.firstName, c.lastName) || c.displayName,
      email: c.email,
      role: c.role,
      discipline: c.discipline,
      onTeam: true,
    }));
}

/** Directory rows → options; internal employees only. */
export function employeeOptions(users: DirectoryUser[], onTeam: boolean): AssigneeOption[] {
  return users.filter(isInternalEmployee).map((u) => ({
    key: `u:${u.id}`,
    userId: u.id,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    displayName: fullName(u.firstName, u.lastName) || u.email || `User #${u.id}`,
    email: u.email ?? null,
    role: null,
    discipline: u.position ?? u.orgUnit?.name ?? null,
    onTeam,
  }));
}

export function matchesSearch(o: AssigneeOption, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [o.displayName, o.firstName, o.lastName, o.email, o.role, o.discipline]
    .some((v) => (v ?? '').toLowerCase().includes(q));
}

/**
 * The picker list. `allEmployees` is used only when the caller can
 * manage the project AND turned on "all employees"; anyone already on
 * the Team keeps his Team row. Already-assigned people are left out.
 */
export function buildAssigneeOptions(args: {
  candidates: AssigneeCandidate[];
  allEmployees?: DirectoryUser[];
  canManage: boolean;
  showAllEmployees: boolean;
  assignedUserIds?: Set<number>;
  search?: string;
}): AssigneeOption[] {
  const team = teamOptions(args.candidates);
  const teamIds = new Set(team.map((o) => o.userId));
  const widened =
    args.canManage && args.showAllEmployees
      ? employeeOptions(args.allEmployees ?? [], false)
          .filter((o) => !teamIds.has(o.userId))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
      : [];
  const assigned = args.assignedUserIds ?? new Set<number>();
  return [...team, ...widened].filter((o) => !assigned.has(o.userId) && matchesSearch(o, args.search ?? ''));
}
