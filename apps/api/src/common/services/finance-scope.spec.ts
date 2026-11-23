/**
 * Round 4 (2026-11-23) — finance-scope.ts: finance:read reaches every
 * project; anyone else needs normal project access.
 */
import { PermissionDeniedException } from '../errors/permission-denied';
import { assertFinanceProjectAccess, financeProjectScope } from './finance-scope';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const FINANCE = { id: 3, isAdmin: false, roleModules: [perm('/finance', { canRead: true })] };
const PM = { id: 4, isAdmin: false, roleModules: [perm('/contracts', { canRead: true })] };
const ADMIN = { id: 1, isAdmin: true, roleModules: [] };

function access(memberOf: number[] = []) {
  return {
    assertProjectAccess: jest.fn(async (_userId: number, projectId: number, isAdmin: boolean) => {
      if (isAdmin || memberOf.includes(projectId)) return;
      throw new PermissionDeniedException("You're not a member of this project.", { reason: 'NOT_PROJECT_MEMBER' });
    }),
    getAccessibleProjectIds: jest.fn(async (_userId: number, isAdmin: boolean) =>
      isAdmin ? { all: true, projectIds: [] } : { all: false, projectIds: memberOf },
    ),
  };
}

describe('assertFinanceProjectAccess', () => {
  it('finance:read passes on any project without a project check', async () => {
    const a = access();
    await assertFinanceProjectAccess(a, FINANCE, 59);
    await assertFinanceProjectAccess(a, FINANCE, null);
    expect(a.assertProjectAccess).not.toHaveBeenCalled();
  });

  it('without finance:read: project access decides', async () => {
    const a = access([59]);
    await assertFinanceProjectAccess(a, PM, 59);
    expect(a.assertProjectAccess).toHaveBeenCalledWith(4, 59, false);
    await expect(assertFinanceProjectAccess(a, PM, 60)).rejects.toMatchObject({
      details: { reason: 'NOT_PROJECT_MEMBER' },
    });
  });

  it('a record with no project: finance:read or Admin only', async () => {
    const a = access([59]);
    await expect(assertFinanceProjectAccess(a, PM, null)).rejects.toMatchObject({
      details: { module: 'finance', action: 'read' },
    });
    await assertFinanceProjectAccess(a, ADMIN, null);
  });
});

describe('financeProjectScope', () => {
  it('null (no limit) for finance:read and Admin; the accessible ids for anyone else', async () => {
    const a = access([59, 61]);
    expect(await financeProjectScope(a, FINANCE)).toBeNull();
    expect(await financeProjectScope(a, ADMIN)).toBeNull();
    expect(await financeProjectScope(a, PM)).toEqual([59, 61]);
  });
});
