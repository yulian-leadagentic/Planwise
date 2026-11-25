import { Prisma, UserType } from '@prisma/client';

/**
 * QA6 (2026-11-25) — who counts as an INTERNAL EMPLOYEE for task
 * assignment, the assignee picker and the `qa6-assignees-to-team`
 * backfill.
 *
 * Source of truth: the User row. `userType` is 'employee' (or the legacy
 * 'both') and the account is active and not deleted. `userType` is
 * derived from the e-mail domain against the home org's domains
 * (UsersService.deriveUserType), so it is set for every login account.
 *
 * Deliberately NOT the person BP's 'employee' partner role: staging has
 * users created through POST /users whose BP lacks that role, and they
 * are still employees. External contacts are either a BP with no User
 * (cannot be a TaskAssignee at all) or a User with userType 'partner'.
 */
export const INTERNAL_USER_TYPES: UserType[] = ['employee', 'both'];

export const INTERNAL_EMPLOYEE_WHERE: Prisma.UserWhereInput = {
  userType: { in: INTERNAL_USER_TYPES },
  isActive: true,
  deletedAt: null,
};

export function isInternalUserType(userType: string | null | undefined): boolean {
  return userType === 'employee' || userType === 'both';
}

export function isInternalEmployee(
  user: { userType?: string | null; isActive?: boolean | null; deletedAt?: Date | null } | null | undefined,
): boolean {
  return !!user && isInternalUserType(user.userType) && user.isActive !== false && user.deletedAt == null;
}
