import { UsersService } from './users.service';

/**
 * Permissions round 3 (2026-11-22) — whoever chose the password decides
 * whether the user must replace it on first sign-in:
 *   • POST /users (Admin / HR picks the password)        → true
 *   • PATCH /users/:id password by an Admin for someone else → true
 *   • an Admin setting his own password through PATCH /users/:id → false
 * (Kept in its own spec file: users.service.spec.ts is being reshaped
 * by another round-3 track.)
 */

const ADMIN = { id: 1, roleId: 9, isAdmin: true, roleModules: [] as any[] };
const HR = {
  id: 3,
  roleId: 4,
  isAdmin: false,
  roleModules: [{ module: { route: '/hr', name: 'hr' }, canRead: true, canWrite: true, canDelete: false }],
};

function makeService(targetId = 50) {
  const target = {
    id: targetId,
    email: 'dana@amec.co.il',
    firstName: 'Dana',
    lastName: 'Levi',
    roleId: 5,
    isActive: true,
    orgUnitId: 10,
    businessPartnerId: null,
    role: { id: 5, name: 'Employee', roleModules: [] },
  };
  const prisma: any = {
    user: {
      findFirst: jest.fn(async (args: any) => {
        if (args?.select?.userRoles) return { role: target.role, userRoles: [{ role: target.role }] };
        if (args?.where?.email) return null;
        return target;
      }),
      update: jest.fn(async ({ data }: any) => ({ ...target, ...data })),
      create: jest.fn(async ({ data }: any) => ({ id: 99, email: data.email, isActive: true, roleId: data.roleId })),
    },
    role: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'Employee', roleModules: [] })) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const activityLog: any = { logSecurityEvent: jest.fn(async () => undefined) };
  const projectAccess: any = { invalidateSubordinateCache: jest.fn() };
  const svc = new UsersService(prisma, {} as any, {} as any, {} as any, activityLog, projectAccess);
  jest.spyOn(svc as any, 'deriveUserType').mockResolvedValue('employee');
  jest.spyOn(svc as any, 'syncEmployeeBpRole').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'resolveUserCode').mockResolvedValue(null);
  jest.spyOn(svc as any, 'ensureBpForUser').mockResolvedValue({ bpId: 77, outcome: 'created' });
  jest.spyOn(svc as any, 'syncPositionToProfession').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncPositionToBpPositionId').mockResolvedValue(undefined);
  return { svc, prisma };
}

const createDto = {
  email: 'new@amec.co.il',
  password: 'secret-pass',
  firstName: 'New',
  lastName: 'Person',
  roleId: 5,
};

describe('mustChangePassword on POST /users', () => {
  it.each([
    ['an Admin', ADMIN],
    ['HR', HR],
  ])('a user created by %s must change the password on first sign-in', async (_who, actor) => {
    const { svc, prisma } = makeService();
    await svc.create({ ...createDto } as any, actor);
    expect(prisma.user.create.mock.calls[0][0].data.mustChangePassword).toBe(true);
  });
});

describe('mustChangePassword on PATCH /users/:id', () => {
  it("an Admin resetting someone else's password sets the flag", async () => {
    const { svc, prisma } = makeService(50);
    await svc.update(50, { password: 'temp-pass-123' } as any, ADMIN);
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(data.password).not.toBe('temp-pass-123');
  });

  it('an Admin changing his own password clears it', async () => {
    const { svc, prisma } = makeService(1);
    await svc.update(1, { password: 'my-own-pass-1' } as any, ADMIN);
    expect(prisma.user.update.mock.calls[0][0].data.mustChangePassword).toBe(false);
  });

  it('an edit without a password leaves the flag alone', async () => {
    const { svc, prisma } = makeService(50);
    await svc.update(50, { firstName: 'Dana' } as any, ADMIN);
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('mustChangePassword');
  });
});
