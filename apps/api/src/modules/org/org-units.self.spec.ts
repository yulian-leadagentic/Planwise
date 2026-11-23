/**
 * Permissions round 4 (review fix) — org-unit self-grant. A home unit
 * grants project access (same unit, and the manager chain), so with
 * org:write a non-Admin must not:
 *   • move HIMSELF to another unit (PATCH /users/:id/org-unit), or
 *   • make HIMSELF a unit's manager (PATCH /org-units/:id/manager, or
 *     POST /org-units with managerUserId).
 * Same 403 as PATCH /users/:id (reason SELF); the stored value sent back
 * passes; Admins are not limited; nothing is written on a refusal.
 */
import { OrgUnitsController } from './org-units.controller';
import { PermissionDeniedException } from '../../common/errors/permission-denied';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
/** Org writer, home unit 3; unit 3 is managed by user 2, unit 4 by user 7. */
const ORG_WRITER = { id: 7, isAdmin: false, roleModules: [perm('/org', { canRead: true, canWrite: true })] };
const ADMIN = { id: 1, isAdmin: true, roleModules: [] };

function make() {
  const orgUnits: any = {
    assignUser: jest.fn(async (userId: number, orgUnitId: number | null) => ({ id: userId, orgUnitId })),
    setManager: jest.fn(async (id: number, userId: number | null) => ({ id, managerUserId: userId })),
    create: jest.fn(async (input: any) => ({ id: 9, ...input })),
  };
  const prisma: any = {
    user: { findFirst: jest.fn(async ({ where }: any) => ({ id: where.id, orgUnitId: 3 })) },
    orgUnit: {
      findFirst: jest.fn(async ({ where }: any) => ({ id: where.id, managerUserId: where.id === 3 ? 2 : 7 })),
    },
  };
  return { ctrl: new OrgUnitsController(orgUnits, prisma), orgUnits };
}

describe('PATCH /users/:id/org-unit — not your own unit', () => {
  it('a non-Admin cannot move himself to another unit (403 SELF); nothing written', async () => {
    const { ctrl, orgUnits } = make();
    for (const orgUnitId of [5, null]) {
      const err = await ctrl.assignUser(ORG_WRITER, 7, { orgUnitId }).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.details).toMatchObject({ field: 'orgUnitId', reason: 'SELF' });
    }
    expect(orgUnits.assignUser).not.toHaveBeenCalled();
  });

  it('sending his current unit back is no change and passes', async () => {
    const { ctrl, orgUnits } = make();
    await ctrl.assignUser(ORG_WRITER, 7, { orgUnitId: 3 });
    expect(orgUnits.assignUser).toHaveBeenCalledWith(7, 3);
  });

  it('he can still move other people; an Admin can move himself', async () => {
    const { ctrl, orgUnits } = make();
    await ctrl.assignUser(ORG_WRITER, 8, { orgUnitId: 5 });
    await ctrl.assignUser(ADMIN, 1, { orgUnitId: 5 });
    expect(orgUnits.assignUser).toHaveBeenCalledTimes(2);
  });
});

describe('PATCH /org-units/:id/manager and POST /org-units — not yourself as manager', () => {
  it('a non-Admin cannot make himself a unit\'s manager (403 SELF); nothing written', async () => {
    const { ctrl, orgUnits } = make();
    const err = await ctrl.setManager(ORG_WRITER, 3, { userId: 7 }).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err.details).toMatchObject({ field: 'managerUserId', reason: 'SELF' });
    expect(orgUnits.setManager).not.toHaveBeenCalled();
  });

  it('nor create a unit with himself as its manager', async () => {
    const { ctrl, orgUnits } = make();
    await expect(ctrl.create(ORG_WRITER, { name: 'New', managerUserId: 7 })).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    expect(orgUnits.create).not.toHaveBeenCalled();
  });

  it('a unit he already manages: sending himself back passes; clearing or picking someone else is allowed', async () => {
    const { ctrl, orgUnits } = make();
    await ctrl.setManager(ORG_WRITER, 4, { userId: 7 });
    await ctrl.setManager(ORG_WRITER, 3, { userId: 8 });
    await ctrl.setManager(ORG_WRITER, 4, { userId: null });
    await ctrl.create(ORG_WRITER, { name: 'New', managerUserId: 8 });
    expect(orgUnits.setManager).toHaveBeenCalledTimes(3);
    expect(orgUnits.create).toHaveBeenCalledTimes(1);
  });

  it('an Admin may make himself a manager', async () => {
    const { ctrl, orgUnits } = make();
    await ctrl.setManager(ADMIN, 3, { userId: 1 });
    await ctrl.create(ADMIN, { name: 'New', managerUserId: 1 });
    expect(orgUnits.setManager).toHaveBeenCalledWith(3, 1);
    expect(orgUnits.create).toHaveBeenCalled();
  });
});
