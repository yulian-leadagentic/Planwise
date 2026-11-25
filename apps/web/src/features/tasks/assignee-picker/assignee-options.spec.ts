import { describe, expect, it } from 'vitest';

import type { AssigneeCandidate } from '@/api/projects.api';
import { buildAssigneeOptions, employeeOptions, isInternalEmployee, teamOptions, type DirectoryUser } from './assignee-options';

/** QA6 package 1 — what a task assignee picker offers. */

const cand = (userId: number | null, over: Partial<AssigneeCandidate> = {}): AssigneeCandidate => ({
  userId,
  partyId: userId != null ? 1000 + userId : 9000,
  firstName: `F${userId ?? 'x'}`,
  lastName: 'L',
  displayName: `F${userId ?? 'x'} L`,
  email: null,
  avatarUrl: null,
  role: 'Participant',
  discipline: null,
  canAssign: userId != null,
  isEmployee: userId != null,
  ...over,
});

const TEAM: AssigneeCandidate[] = [
  cand(101),
  cand(102, { role: 'BIM Leader' }),
  // external contact holding a Team role, with a partner login
  cand(107, { canAssign: false, isEmployee: false, role: 'Architect' }),
  // external contact with no user at all
  cand(null, { displayName: 'Outside Engineer', role: 'Engineer' }),
];

const DIRECTORY: DirectoryUser[] = [
  { id: 101, firstName: 'F101', lastName: 'L', userType: 'employee', isActive: true },
  { id: 105, firstName: 'Noa', lastName: 'Cohen', userType: 'employee', isActive: true, position: 'Modeler' },
  { id: 106, firstName: 'Avi', lastName: 'Levi', userType: 'both' },
  { id: 107, firstName: 'Arch', lastName: 'Outside', userType: 'partner', isActive: true },
  { id: 108, firstName: 'Old', lastName: 'Timer', userType: 'employee', isActive: false },
];

const ids = (rows: { userId: number }[]) => rows.map((r) => r.userId);

describe('assignee picker options (QA6)', () => {
  it('by default: the Team only, employees only (external contacts never appear)', () => {
    const rows = buildAssigneeOptions({ candidates: TEAM, allEmployees: DIRECTORY, canManage: false, showAllEmployees: false });
    expect(ids(rows)).toEqual([101, 102]);
    expect(rows.every((r) => r.onTeam)).toBe(true);
  });

  it('a non-manager gets the Team only, even if "all employees" was somehow on', () => {
    const rows = buildAssigneeOptions({ candidates: TEAM, allEmployees: DIRECTORY, canManage: false, showAllEmployees: true });
    expect(ids(rows)).toEqual([101, 102]);
  });

  it('a leader / Admin with "all employees": Team first, then other employees marked as joining the Team', () => {
    const rows = buildAssigneeOptions({ candidates: TEAM, allEmployees: DIRECTORY, canManage: true, showAllEmployees: true });
    expect(ids(rows)).toEqual([101, 102, 106, 105]); // Avi Levi, Noa Cohen: alphabetical
    expect(rows.filter((r) => !r.onTeam).map((r) => r.userId)).toEqual([106, 105]);
    // A Team member is not listed twice; externals and inactive users never.
    expect(ids(rows)).not.toContain(107);
    expect(ids(rows)).not.toContain(108);
  });

  it('a leader / Admin without the toggle sees the Team only', () => {
    const rows = buildAssigneeOptions({ candidates: TEAM, allEmployees: DIRECTORY, canManage: true, showAllEmployees: false });
    expect(ids(rows)).toEqual([101, 102]);
  });

  it('already-assigned people and the search filter apply to both groups', () => {
    const rows = buildAssigneeOptions({
      candidates: TEAM,
      allEmployees: DIRECTORY,
      canManage: true,
      showAllEmployees: true,
      assignedUserIds: new Set([101]),
      search: 'mode',
    });
    expect(ids(rows)).toEqual([105]); // matches "Modeler"
    expect(
      ids(buildAssigneeOptions({ candidates: TEAM, canManage: false, showAllEmployees: false, search: 'bim' })),
    ).toEqual([102]);
  });

  it('a server row with canAssign false is dropped even when it has a user id', () => {
    expect(ids(teamOptions([cand(107, { canAssign: false })]))).toEqual([]);
    expect(ids(teamOptions([cand(108, { canAssign: true, isEmployee: false })]))).toEqual([]);
  });

  it('personal tasks: the directory, employees only', () => {
    expect(ids(employeeOptions(DIRECTORY, true))).toEqual([101, 105, 106]);
    expect(isInternalEmployee({ userType: 'partner', isActive: true })).toBe(false);
    expect(isInternalEmployee({ userType: 'employee', isActive: false })).toBe(false);
    expect(isInternalEmployee({ userType: 'employee' })).toBe(true);
  });
});
