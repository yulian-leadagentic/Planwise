import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { isAdminLevelRole } from './user-write-policy';

/**
 * Permissions round 1 (2026-11-20) — protected user fields and who may
 * add / remove employees (owner decision 6), plus the `security` audit
 * rows those writes produce (decision 3).
 *
 *   POST /users     → Admin or HR (hr:write) only; non-admin may assign
 *                     only a non-admin role.
 *   PATCH /users/:id → Admin, partners:write or hr:write. password /
 *                     roleId → Admin only; email / isActive → Admin or
 *                     HR; a field only counts when its value changes.
 *   DELETE /users/:id → Admin or HR only; nobody deletes themselves.
 */

function perm(route: string, flags: Partial<Record<'canRead' | 'canWrite' | 'canDelete', boolean>>) {
  return { module: { route, name: route.replace(/^\//, '') }, canRead: false, canWrite: false, canDelete: false, ...flags };
}

const ADMIN = { id: 1, roleId: 9, isAdmin: true, roleModules: [] as any[] };
const PARTNERS_WRITER = {
  id: 2,
  roleId: 3,
  isAdmin: false,
  roleModules: [perm('/partners', { canRead: true, canWrite: true, canDelete: true })],
};
const HR = { id: 3, roleId: 4, isAdmin: false, roleModules: [perm('/hr', { canRead: true, canWrite: true })] };
const NOBODY = { id: 4, roleId: 5, isAdmin: false, roleModules: [perm('/projects', { canRead: true })] };
const ORG_WRITER = {
  id: 5,
  roleId: 6,
  isAdmin: false,
  roleModules: [perm('/partners', { canRead: true, canWrite: true }), perm('/org', { canRead: true, canWrite: true })],
};

const ROLES: Record<number, any> = {
  1: { id: 1, name: 'Admin', roleModules: [] },
  3: { id: 3, name: 'Depatment lead', roleModules: [{ ...perm('/admin/activity-log', { canRead: true }) }] },
  5: { id: 5, name: 'Employee', roleModules: [] },
  7: { id: 7, name: 'Ops super-user', roleModules: [{ ...perm('/admin', { canRead: true }) }] },
};

function existingUser(over: Partial<any> = {}) {
  return {
    id: 50,
    email: 'dana@amec.co.il',
    firstName: 'Dana',
    lastName: 'Levi',
    roleId: 5,
    isActive: true,
    orgUnitId: 10,
    businessPartnerId: null,
    role: { id: 5, name: 'Employee', roleModules: [] },
    ...over,
  };
}

function makeService(opts: { target?: any; targetRoles?: { role: any; userRoles: any[] } } = {}) {
  const target = opts.target ?? existingUser();
  const targetRoles = opts.targetRoles ?? { role: target.role, userRoles: [{ role: target.role }] };
  const prisma: any = {
    user: {
      // findOne (select has `email`) vs isAdminLevelUser (select has `userRoles`)
      // vs create's duplicate-email check (where.email).
      findFirst: jest.fn(async (args: any) => {
        if (args?.select?.userRoles) return targetRoles;
        if (args?.where?.email) return null;
        return target;
      }),
      update: jest.fn(async ({ data }: any) => ({ ...target, ...data })),
      create: jest.fn(async ({ data }: any) => ({ id: 99, email: data.email, isActive: true, roleId: data.roleId })),
      delete: jest.fn(async () => target),
    },
    role: { findUnique: jest.fn(async ({ where }: any) => ROLES[where.id] ?? null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const activityLog: any = { logSecurityEvent: jest.fn(async () => undefined) };
  const svc = new UsersService(prisma, {} as any, {} as any, {} as any, activityLog);
  // Side effects that are not under test.
  jest.spyOn(svc as any, 'deriveUserType').mockResolvedValue('employee');
  jest.spyOn(svc as any, 'syncEmployeeBpRole').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'resolveUserCode').mockResolvedValue(null);
  jest.spyOn(svc as any, 'ensureBpForUser').mockResolvedValue({ bpId: 77, outcome: 'created' });
  jest.spyOn(svc as any, 'syncPositionToProfession').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncPositionToBpPositionId').mockResolvedValue(undefined);
  return { svc, prisma, activityLog, target };
}

const createDto = (roleId: number) => ({
  email: 'new@amec.co.il',
  password: 'secret-pass',
  firstName: 'New',
  lastName: 'Person',
  roleId,
});

describe('isAdminLevelRole', () => {
  it('flags the Admin role and roles with any flag on the top-level /admin module only', () => {
    expect(isAdminLevelRole(ROLES[1])).toBe(true);
    expect(isAdminLevelRole(ROLES[7])).toBe(true);
    expect(isAdminLevelRole(ROLES[3])).toBe(false); // admin/activity-log is a sub-module
    expect(isAdminLevelRole(ROLES[5])).toBe(false);
    expect(isAdminLevelRole({ name: 'X', roleModules: [perm('/admin', {})] })).toBe(false); // no flag set
  });
});

describe('UsersService — PATCH /users/:id protected fields', () => {
  it.each([
    ['password', { password: 'new-password-1' }, '"password"'],
    ['roleId', { roleId: 1 }, '"roleId"'],
    ['email', { email: 'evil@x.com' }, '"email"'],
    ['isActive', { isActive: false }, '"isActive"'],
    ['orgUnitId', { orgUnitId: 99 }, '"orgUnitId"'],
    ['orgUnitId (cleared)', { orgUnitId: null }, '"orgUnitId"'],
  ])('non-admin with partners:write gets 403 when changing %s', async (_f, dto, fieldInMessage) => {
    const { svc, prisma, activityLog } = makeService();
    const err = await svc.update(50, dto as any, PARTNERS_WRITER).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toContain(fieldInMessage);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(activityLog.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('unchanged protected values pass (the edit modal sends the whole form)', async () => {
    const { svc, prisma, activityLog } = makeService();
    await svc.update(
      50,
      { email: 'dana@amec.co.il', roleId: 5, isActive: true, orgUnitId: 10, firstName: 'Dana R.' } as any,
      PARTNERS_WRITER,
    );
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(activityLog.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('a caller with neither Admin, partners:write nor hr:write cannot open the route', async () => {
    const { svc } = makeService();
    await expect(svc.update(50, { firstName: 'X' } as any, NOBODY)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('HR may change email and isActive of an employee (audited old → new)', async () => {
    const { svc, prisma, activityLog } = makeService();
    await svc.update(50, { email: 'dana.l@amec.co.il', isActive: false } as any, HR);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const actions = activityLog.logSecurityEvent.mock.calls.map((c: any[]) => c[0].action);
    expect(actions).toEqual(['user.email_change', 'user.deactivate']);
    const email = activityLog.logSecurityEvent.mock.calls[0][0];
    expect(email.changes).toEqual({ email: { from: 'dana@amec.co.il', to: 'dana.l@amec.co.il' } });
    expect(email.actorUserId).toBe(HR.id);
    expect(activityLog.logSecurityEvent.mock.calls[1][0].changes).toEqual({ isActive: { from: true, to: false } });
  });

  it('HR may not change roleId or password', async () => {
    const { svc } = makeService();
    await expect(svc.update(50, { roleId: 3 } as any, HR)).rejects.toThrow('"roleId"');
    await expect(svc.update(50, { password: 'x-123456' } as any, HR)).rejects.toThrow('"password"');
  });

  it('nobody but an Admin changes their own isActive / roleId', async () => {
    const self = existingUser({ id: HR.id });
    const { svc } = makeService({ target: self });
    await expect(svc.update(HR.id, { isActive: false } as any, HR)).rejects.toThrow('own active state');
    await expect(svc.update(HR.id, { roleId: 1 } as any, HR)).rejects.toThrow('own access role');
  });

  it('HR may not change email / isActive of an Admin user', async () => {
    const adminTarget = existingUser({ id: 60, roleId: 1, role: ROLES[1] });
    const { svc, prisma } = makeService({ target: adminTarget });
    await expect(svc.update(60, { email: 'hr-owned@x.com' } as any, HR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.update(60, { isActive: false } as any, HR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('Admin changes password + roleId; audit records THAT the password changed, never the value', async () => {
    const { svc, prisma, activityLog } = makeService();
    await svc.update(50, { password: 'brand-new-pass', roleId: 3 } as any, ADMIN);

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.password).not.toBe('brand-new-pass'); // bcrypt hash
    expect(data.roleId).toBe(3);

    const calls = activityLog.logSecurityEvent.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.action)).toEqual(['user.role_change', 'user.password_change']);
    expect(calls[0].changes).toEqual({
      roleId: { from: { id: 5, name: 'Employee' }, to: { id: 3, name: 'Depatment lead' } },
    });
    expect(calls[1].changes).toEqual({ password: 'changed' });
    const serialized = JSON.stringify(activityLog.logSecurityEvent.mock.calls);
    expect(serialized).not.toContain('brand-new-pass');
    expect(serialized).not.toContain(data.password);
  });

  describe('orgUnitId (home unit widens project access)', () => {
    it('org:write may move another user (audited old → new unit id)', async () => {
      const { svc, prisma, activityLog } = makeService();
      await svc.update(50, { orgUnitId: 99 } as any, ORG_WRITER);
      expect(prisma.user.update.mock.calls[0][0].data.orgUnitId).toBe(99);
      expect(activityLog.logSecurityEvent.mock.calls[0][0]).toMatchObject({
        action: 'user.org_unit_change',
        actorUserId: ORG_WRITER.id,
        entityId: 50,
        changes: { orgUnitId: { from: 10, to: 99 } },
      });
    });

    it('HR may move another user; clearing to null is a change too', async () => {
      const { svc, activityLog } = makeService();
      await svc.update(50, { orgUnitId: null } as any, HR);
      expect(activityLog.logSecurityEvent.mock.calls[0][0].changes).toEqual({ orgUnitId: { from: 10, to: null } });
    });

    it('a non-admin cannot change their OWN org unit, even with org:write or hr:write', async () => {
      for (const actor of [ORG_WRITER, HR]) {
        const { svc, prisma } = makeService({ target: existingUser({ id: actor.id }) });
        await expect(svc.update(actor.id, { orgUnitId: 99 } as any, actor)).rejects.toThrow('own department');
        expect(prisma.user.update).not.toHaveBeenCalled();
      }
    });

    it('partners:write sending its own unchanged orgUnitId passes', async () => {
      const { svc, prisma, activityLog } = makeService({ target: existingUser({ id: PARTNERS_WRITER.id }) });
      await svc.update(PARTNERS_WRITER.id, { orgUnitId: 10, firstName: 'Me' } as any, PARTNERS_WRITER);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(activityLog.logSecurityEvent).not.toHaveBeenCalled();
    });

    it('an Admin may change their own org unit', async () => {
      const { svc, prisma } = makeService({ target: existingUser({ id: ADMIN.id }) });
      await svc.update(ADMIN.id, { orgUnitId: 99 } as any, ADMIN);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });
  });

  it('Admin assigning a role that does not exist gets 400', async () => {
    const { svc } = makeService();
    await expect(svc.update(50, { roleId: 404 } as any, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UsersService — POST /users (create)', () => {
  it('partners:write alone cannot create users', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.create(createDto(5) as any, PARTNERS_WRITER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('HR creates a user with a non-admin role and an org unit (audited)', async () => {
    const { svc, prisma, activityLog } = makeService();
    await svc.create({ ...createDto(5), orgUnitId: 10 } as any, HR);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.create.mock.calls[0][0].data.orgUnitId).toBe(10);
    const entry = activityLog.logSecurityEvent.mock.calls[0][0];
    expect(entry.action).toBe('user.create');
    expect(entry.actorUserId).toBe(HR.id);
    expect(entry.changes.roleId.to).toEqual({ id: 5, name: 'Employee' });
    expect(JSON.stringify(entry)).not.toContain('secret-pass');
  });

  it.each([[1, 'Admin'], [7, 'Ops super-user (/admin module)']])(
    'HR gets 403 assigning admin-level role %s (%s)',
    async (roleId) => {
      const { svc, prisma } = makeService();
      const err = await svc.create(createDto(roleId) as any, HR).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toContain('"roleId"');
      expect(prisma.user.create).not.toHaveBeenCalled();
    },
  );

  it('Admin may create another Admin', async () => {
    const { svc, prisma } = makeService();
    await svc.create(createDto(1) as any, ADMIN);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });
});

describe('UsersService — DELETE /users/:id', () => {
  it('partners:write (+delete) cannot delete users', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.remove(50, PARTNERS_WRITER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('nobody deletes themselves — not even an Admin', async () => {
    const { svc, prisma } = makeService({ target: existingUser({ id: ADMIN.id }) });
    await expect(svc.remove(ADMIN.id, ADMIN)).rejects.toThrow('your own account');
    await expect(svc.remove(HR.id, HR)).rejects.toThrow('your own account');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('HR deletes an employee (audited), but not an Admin', async () => {
    const { svc, prisma, activityLog } = makeService();
    await svc.remove(50, HR);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 50 } });
    expect(activityLog.logSecurityEvent.mock.calls[0][0]).toMatchObject({
      action: 'user.delete',
      entityId: 50,
      actorUserId: HR.id,
    });

    const adminTarget = existingUser({ id: 60, roleId: 1, role: ROLES[1] });
    const other = makeService({ target: adminTarget });
    await expect(other.svc.remove(60, HR)).rejects.toThrow('Admin user');
    expect(other.prisma.user.delete).not.toHaveBeenCalled();
  });
});

/**
 * Permissions round 2 (2026-11-20) — B-14: a person's pay rate
 * (`salaryHourly`) and labor category (`seniorityLevelId`, the cost
 * tier) change only with finance:write. Unchanged values pass (the edit
 * modal sends the whole form).
 */
describe('UsersService — money on a person needs finance:write', () => {
  const FINANCE_PARTNERS_WRITER = {
    ...PARTNERS_WRITER,
    roleModules: [...PARTNERS_WRITER.roleModules, perm('/finance', { canRead: true, canWrite: true })],
  };
  const stored = () => existingUser({ salaryHourly: '85.00', seniorityLevelId: 2 });

  it.each([
    ['salaryHourly', { salaryHourly: 120 }],
    ['salaryHourly (cleared)', { salaryHourly: null }],
    ['seniorityLevelId', { seniorityLevelId: 3 }],
  ])('PATCH changing %s without finance:write → 403, nothing written', async (_f, dto) => {
    const { svc, prisma } = makeService({ target: stored() });
    await expect(svc.update(50, dto as any, PARTNERS_WRITER)).rejects.toThrow(/requires finance:write/);
    await expect(svc.update(50, dto as any, ADMIN)).rejects.toThrow(/requires finance:write/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('PATCH echoing the stored rate / level passes', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    // the M17 routing sees the same open level and records nothing
    prisma.userSeniority = { findFirst: jest.fn(async () => ({ id: 1, seniorityLevelId: 2 })) };
    await svc.update(50, { firstName: 'Dana R.', salaryHourly: 85, seniorityLevelId: 2 } as any, PARTNERS_WRITER);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('a finance writer changes the rate', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    await svc.update(50, { salaryHourly: 120 } as any, FINANCE_PARTNERS_WRITER);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('POST with a pay rate or a labor category needs finance:write', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.create({ ...createDto(5), salaryHourly: 90 } as any, HR)).rejects.toThrow(/salaryHourly requires finance:write/);
    await expect(svc.create({ ...createDto(5), seniorityLevelId: 2 } as any, HR)).rejects.toThrow(/seniorityLevelId/);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
