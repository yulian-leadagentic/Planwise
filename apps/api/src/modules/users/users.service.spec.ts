import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { isAdminLevelRole } from './user-write-policy';
import { findPersonalFieldChanges, userFieldAccess } from './user-visibility';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { buildCostRateResolver } from '../projects/cost-rate-resolver';

// The cost resolver hits several tables; the tier tests only care
// whether it runs at all.
jest.mock('../projects/cost-rate-resolver', () => ({
  buildCostRateResolver: jest.fn(async () => ({
    resolve: () => ({ hourlyCost: 240, source: 'user_override' }),
  })),
  isRateableOutcome: () => true,
}));

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

function makeService(
  opts: { target?: any; targetRoles?: { role: any; userRoles: any[] }; rows?: any[] } = {},
) {
  const target = opts.target ?? existingUser();
  const targetRoles = opts.targetRoles ?? { role: target.role, userRoles: [{ role: target.role }] };
  const rows = opts.rows ?? [{ id: 50, firstName: 'Dana', userType: 'employee', role: { id: 5, name: 'Employee' } }];
  const prisma: any = {
    user: {
      // findOne (select has `email`) vs isAdminLevelUser (select has `userRoles`)
      // vs create's duplicate-email check (where.email).
      findFirst: jest.fn(async (args: any) => {
        if (args?.select?.userRoles) return targetRoles;
        if (args?.where?.email) return null;
        return target;
      }),
      findMany: jest.fn(async () => rows),
      count: jest.fn(async () => rows.length),
      update: jest.fn(async ({ data }: any) => ({ ...target, ...data })),
      create: jest.fn(async ({ data }: any) => ({ id: 99, email: data.email, isActive: true, roleId: data.roleId })),
      delete: jest.fn(async () => target),
    },
    role: { findUnique: jest.fn(async ({ where }: any) => ROLES[where.id] ?? null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const activityLog: any = { logSecurityEvent: jest.fn(async () => undefined) };
  const projectAccess: any = { invalidateSubordinateCache: jest.fn() };
  const svc = new UsersService(prisma, {} as any, {} as any, {} as any, activityLog, projectAccess);
  // Side effects that are not under test.
  jest.spyOn(svc as any, 'deriveUserType').mockResolvedValue('employee');
  jest.spyOn(svc as any, 'syncEmployeeBpRole').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'resolveUserCode').mockResolvedValue(null);
  jest.spyOn(svc as any, 'ensureBpForUser').mockResolvedValue({ bpId: 77, outcome: 'created' });
  jest.spyOn(svc as any, 'syncPositionToProfession').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncPositionToBpPositionId').mockResolvedValue(undefined);
  return { svc, prisma, activityLog, projectAccess, target };
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
    ['password', { password: 'new-password-1' }, 'password', "Only an Admin can set a user's password."],
    ['roleId', { roleId: 1 }, 'roleId', "Only an Admin can change a user's access role."],
    ['email', { email: 'evil@x.com' }, 'email', "Only an Admin or HR can change a user's email address."],
    ['isActive', { isActive: false }, 'isActive', 'Only an Admin or HR can activate or deactivate a user.'],
    [
      'orgUnitId',
      { orgUnitId: 99 },
      'orgUnitId',
      "Only an Admin, HR or someone who can change the organization structure can change a user's department.",
    ],
    [
      'orgUnitId (cleared)',
      { orgUnitId: null },
      'orgUnitId',
      "Only an Admin, HR or someone who can change the organization structure can change a user's department.",
    ],
  ])('non-admin with partners:write gets 403 when changing %s', async (_f, dto, field, message) => {
    const { svc, prisma, activityLog } = makeService();
    const err = await svc.update(50, dto as any, PARTNERS_WRITER).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    // Plain words for the user; the raw field name only in details.
    expect(err.message).toBe(message);
    expect(err.message).not.toContain(`"${field}"`);
    expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', details: { field } });
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
    await expect(svc.update(50, { firstName: 'X' } as any, NOBODY)).rejects.toThrow(
      "You don't have permission to edit people. Ask your administrator for access.",
    );
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
    await expect(svc.update(50, { roleId: 3 } as any, HR)).rejects.toThrow("Only an Admin can change a user's access role.");
    await expect(svc.update(50, { password: 'x-123456' } as any, HR)).rejects.toThrow("Only an Admin can set a user's password.");
  });

  it('nobody but an Admin changes their own isActive / roleId', async () => {
    const self = existingUser({ id: HR.id });
    const { svc } = makeService({ target: self });
    await expect(svc.update(HR.id, { isActive: false } as any, HR)).rejects.toThrow("You can't change your own active status.");
    await expect(svc.update(HR.id, { roleId: 1 } as any, HR)).rejects.toThrow("You can't change your own access role.");
  });

  it('HR may not change email / isActive of an Admin user', async () => {
    const adminTarget = existingUser({ id: 60, roleId: 1, role: ROLES[1] });
    const { svc, prisma } = makeService({ target: adminTarget });
    await expect(svc.update(60, { email: 'hr-owned@x.com' } as any, HR)).rejects.toThrow(
      'Only an Admin can change the email address of an Admin user.',
    );
    await expect(svc.update(60, { isActive: false } as any, HR)).rejects.toThrow(
      'Only an Admin can activate or deactivate an Admin user.',
    );
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
    await expect(svc.create(createDto(5) as any, PARTNERS_WRITER)).rejects.toThrow('Only an Admin or HR can add employees.');
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
      expect(err.message).toMatch(/^Only an Admin can give someone the ".+" access role/);
      expect(err.getResponse().details).toEqual({ field: 'roleId', reason: 'ADMIN_ONLY' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    },
  );

  it('Admin may create another Admin', async () => {
    const { svc, prisma } = makeService();
    await svc.create(createDto(1) as any, ADMIN);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  // QA6 (2026-11-25): staging showed users created through POST /users
  // with userType 'employee' whose person BP had no 'employee' partner
  // role. The create path writes both from the same derived value; these
  // pin it down with the real deriveUserType + syncEmployeeBpRole.
  describe('the employee partner role on the person BP (QA6)', () => {
    const withRealSync = () => {
      const ctx = makeService();
      (ctx.svc as any).deriveUserType.mockRestore();
      (ctx.svc as any).syncEmployeeBpRole.mockRestore();
      (ctx.svc as any).bpService = {
        getHomeOrg: jest.fn(async () => ({ domains: [{ domain: 'amec.co.il', isPersonal: false }] })),
      };
      ctx.prisma.partnerRoleType = { findUnique: jest.fn(async () => ({ id: 1, code: 'employee' })) };
      ctx.prisma.businessPartnerRole = { upsert: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 0 })) };
      return ctx;
    };

    it('a home-domain email → userType employee AND the BP gets the employee role', async () => {
      const { svc, prisma } = withRealSync();
      await svc.create(createDto(5) as any, ADMIN);
      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ userType: 'employee', businessPartnerId: 77 });
      expect(prisma.businessPartnerRole.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { businessPartnerId_roleTypeId: { businessPartnerId: 77, roleTypeId: 1 } },
          create: { businessPartnerId: 77, roleTypeId: 1, isPrimary: false },
        }),
      );
    });

    it('an outside email → userType partner and no employee role', async () => {
      const { svc, prisma } = withRealSync();
      await svc.create({ ...createDto(5), email: 'someone@gmail.com' } as any, ADMIN);
      expect(prisma.user.create.mock.calls[0][0].data.userType).toBe('partner');
      expect(prisma.businessPartnerRole.upsert).not.toHaveBeenCalled();
    });
  });
});

describe('UsersService — DELETE /users/:id', () => {
  it('partners:write (+delete) cannot delete users', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.remove(50, PARTNERS_WRITER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove(50, PARTNERS_WRITER)).rejects.toThrow('Only an Admin or HR can delete employees.');
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
    await expect(svc.update(50, dto as any, PARTNERS_WRITER)).rejects.toThrow(/needs permission to change financial data/);
    await expect(svc.update(50, dto as any, ADMIN)).rejects.toThrow(/needs permission to change financial data/);
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
    await expect(svc.create({ ...createDto(5), salaryHourly: 90 } as any, HR)).rejects.toThrow(
      "You can't change salary rates — that needs permission to change financial data. Ask your administrator.",
    );
    await expect(svc.create({ ...createDto(5), seniorityLevelId: 2 } as any, HR)).rejects.toThrow(
      "You can't change the labor category — that needs permission to change financial data. Ask your administrator.",
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

/**
 * Permissions round 3 (privacy, 2026-11-22) — who sees which User fields
 * on the /users routes (user-visibility.ts):
 *   directory → everyone with the route (names, email, phone, avatar,
 *               type, position, org unit, company, partner id);
 *   account   → + Admin / HR (hr:read) / the user himself (code, role,
 *               active state, last login, created at, labor category);
 *   personal  → + HR / the user himself (employment dates, daily
 *               standard, employee category, employment type, payroll
 *               no., tax ID, address, website) — NOT an Admin without hr;
 *   role.roleModules → Admin / the user himself.
 */
describe('UsersService — round 3: field tiers on GET /users and GET /users/:id', () => {
  const HR_CLERK = { id: 6, roleId: 7, isAdmin: false, roleModules: [perm('/hr', { canRead: true })] };
  const HR_FINANCE = {
    id: 7,
    roleId: 8,
    isAdmin: false,
    roleModules: [perm('/hr', { canRead: true, canWrite: true }), perm('/finance', { canRead: true })],
  };
  const DIRECTORY_KEYS = [
    'id', 'firstName', 'lastName', 'firstNameHe', 'lastNameHe', 'email', 'phone', 'avatarUrl',
    'userType', 'position', 'orgUnitId', 'orgUnit', 'companyName', 'businessPartnerId',
  ];
  const ACCOUNT_KEYS = ['code', 'roleId', 'role', 'isActive', 'lastLoginAt', 'createdAt', 'seniorityLevelId', 'seniorityLevel'];
  const PERSONAL_KEYS = [
    'employmentDate', 'employmentEndDate', 'dailyStandardHours', 'employeeCategory', 'employmentType',
    'accountingEmployeeNumber', 'taxId', 'address', 'website',
  ];
  const sorted = (keys: string[]) => [...keys].sort();
  const listSelect = (prisma: any) => prisma.user.findMany.mock.calls[0][0].select;
  const oneSelect = (prisma: any) => prisma.user.findFirst.mock.calls.at(-1)[0].select;

  beforeEach(() => (buildCostRateResolver as jest.Mock).mockClear());

  describe('GET /users', () => {
    it('a directory caller (partners:read/write, no Admin, no HR) gets the directory tier only — phone included', async () => {
      const { svc, prisma } = makeService();
      const out: any = await svc.findAll({} as any, PARTNERS_WRITER);
      expect(sorted(Object.keys(listSelect(prisma)))).toEqual(sorted(DIRECTORY_KEYS));
      expect(listSelect(prisma).phone).toBe(true);
      // rows go out as selected: no role name, no rate, resolver never runs
      expect(out.data[0]).not.toHaveProperty('roleName');
      expect(out.data[0]).not.toHaveProperty('effectiveHourlyCost');
      expect(buildCostRateResolver).not.toHaveBeenCalled();
      expect(out.meta).toEqual({ total: 1, page: 1, perPage: 20, totalPages: 1 });
    });

    it('an Admin without hr gets the account tier but NOT the personal tier', async () => {
      const { svc, prisma } = makeService();
      const out: any = await svc.findAll({} as any, ADMIN);
      expect(sorted(Object.keys(listSelect(prisma)))).toEqual(sorted([...DIRECTORY_KEYS, ...ACCOUNT_KEYS]));
      expect(listSelect(prisma).role).toEqual({ select: { id: true, name: true } });
      expect(out.data[0].roleName).toBe('Employee');
      // no finance:read → the rate is not computed at all
      expect(out.data[0]).not.toHaveProperty('effectiveHourlyCost');
      expect(buildCostRateResolver).not.toHaveBeenCalled();
    });

    it('HR (hr:read) gets account + personal tiers', async () => {
      const { svc, prisma } = makeService();
      await svc.findAll({} as any, HR_CLERK);
      expect(sorted(Object.keys(listSelect(prisma)))).toEqual(sorted([...DIRECTORY_KEYS, ...ACCOUNT_KEYS, ...PERSONAL_KEYS]));
    });

    it('the effective rate is computed only for an Admin / HR caller who also holds finance:read', async () => {
      const { svc } = makeService();
      const out: any = await svc.findAll({} as any, HR_FINANCE);
      expect(buildCostRateResolver).toHaveBeenCalledTimes(1);
      expect(out.data[0]).toMatchObject({ roleName: 'Employee', effectiveHourlyCost: 240, rateSource: 'override' });
    });

    it('soft-deleted users never surface; active-only by default', async () => {
      const { svc, prisma } = makeService();
      await svc.findAll({} as any, PARTNERS_WRITER);
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null, isActive: true });
      expect(prisma.user.count.mock.calls[0][0].where).toEqual({ deletedAt: null, isActive: true });
    });

    it.each([[false], ['all']])('only Admin / HR may list inactive users (isActive=%s)', async (isActive) => {
      const { svc, prisma } = makeService();
      const err = await svc.findAll({ isActive } as any, PARTNERS_WRITER).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.message).toBe('Only an Admin or HR can list inactive users.');
      expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', details: { field: 'isActive' } });
      expect(prisma.user.findMany).not.toHaveBeenCalled();

      for (const actor of [ADMIN, HR_CLERK]) {
        const ok = makeService();
        await ok.svc.findAll({ isActive } as any, actor);
        const where = ok.prisma.user.findMany.mock.calls[0][0].where;
        expect(where.isActive).toBe(isActive === 'all' ? undefined : false);
      }
    });

    it('isActive=true stays open to everyone', async () => {
      const { svc, prisma } = makeService();
      await svc.findAll({ isActive: true } as any, PARTNERS_WRITER);
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    });

    it('only Admin / HR may filter by access role (would reveal role membership)', async () => {
      const { svc } = makeService();
      await expect(svc.findAll({ roleId: 1 } as any, PARTNERS_WRITER)).rejects.toThrow(
        'Only an Admin or HR can filter people by access role.',
      );
      const ok = makeService();
      await ok.svc.findAll({ roleId: 1 } as any, ADMIN);
      expect(ok.prisma.user.findMany.mock.calls[0][0].where.roleId).toBe(1);
    });
  });

  describe('GET /users/:id', () => {
    it('a directory caller sees the directory tier of someone else — no role, no employment data', async () => {
      const { svc, prisma } = makeService();
      await svc.findOne(50, PARTNERS_WRITER);
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ id: 50, deletedAt: null });
      expect(sorted(Object.keys(oneSelect(prisma)))).toEqual(sorted(DIRECTORY_KEYS));
    });

    it('the user himself gets every tier on his own record, permission matrix included', async () => {
      const { svc, prisma } = makeService({ target: existingUser({ id: PARTNERS_WRITER.id }) });
      await svc.findOne(PARTNERS_WRITER.id, PARTNERS_WRITER);
      const select = oneSelect(prisma);
      expect(sorted(Object.keys(select))).toEqual(sorted([...DIRECTORY_KEYS, ...ACCOUNT_KEYS, ...PERSONAL_KEYS]));
      expect(select.role).toEqual({ include: { roleModules: { include: { module: true } } } });
    });

    it('an Admin without hr: account tier + permission matrix, no personal tier (except his own record)', async () => {
      const { svc, prisma } = makeService();
      await svc.findOne(50, ADMIN);
      const select = oneSelect(prisma);
      expect(sorted(Object.keys(select))).toEqual(sorted([...DIRECTORY_KEYS, ...ACCOUNT_KEYS]));
      expect(select.role).toEqual({ include: { roleModules: { include: { module: true } } } });

      const self = makeService({ target: existingUser({ id: ADMIN.id }) });
      await self.svc.findOne(ADMIN.id, ADMIN);
      expect(oneSelect(self.prisma)).toMatchObject({ taxId: true, employmentEndDate: true });
    });

    it('HR: account + personal tiers, but the role only as { id, name } (no permission matrix)', async () => {
      const { svc, prisma } = makeService();
      await svc.findOne(50, HR_CLERK);
      const select = oneSelect(prisma);
      expect(sorted(Object.keys(select))).toEqual(sorted([...DIRECTORY_KEYS, ...ACCOUNT_KEYS, ...PERSONAL_KEYS]));
      expect(select.role).toEqual({ select: { id: true, name: true } });
    });

    it('userFieldAccess — the rules in one table', () => {
      expect(userFieldAccess(PARTNERS_WRITER, 50)).toEqual({ account: false, personal: false, roleModules: false });
      expect(userFieldAccess(ADMIN, 50)).toEqual({ account: true, personal: false, roleModules: true });
      expect(userFieldAccess(HR_CLERK, 50)).toEqual({ account: true, personal: true, roleModules: false });
      expect(userFieldAccess(NOBODY, NOBODY.id)).toEqual({ account: true, personal: true, roleModules: true });
      // a list (no target) never applies "himself"
      expect(userFieldAccess(NOBODY)).toEqual({ account: false, personal: false, roleModules: false });
    });
  });

  it('GET /users/:id/seniorities (labor category history) — Admin, HR or the user himself', async () => {
    const seniority: any = { listForUser: jest.fn(async () => []) };
    const ctrl = new UsersController({} as any, seniority);
    expect(() => ctrl.listSeniorities(PARTNERS_WRITER, 50)).toThrow(
      "Only an Admin or HR can view a person's labor category history.",
    );
    expect(seniority.listForUser).not.toHaveBeenCalled();
    for (const [actor, id] of [[ADMIN, 50], [HR_CLERK, 50], [PARTNERS_WRITER, PARTNERS_WRITER.id]] as const) {
      await ctrl.listSeniorities(actor, id);
    }
    expect(seniority.listForUser).toHaveBeenCalledTimes(3);
  });
});

describe('UsersService — round 3: personal fields need hr:write', () => {
  const stored = () =>
    existingUser({
      code: 'E-100',
      employmentDate: new Date('2024-03-01T00:00:00.000Z'),
      employmentEndDate: new Date('2027-12-31T00:00:00.000Z'),
      dailyStandardHours: '8.40',
      employeeCategory: null,
      taxId: '123456789',
      address: 'Herzl 1, Tel Aviv',
      website: null,
    });
  const tail = ' — only HR can change employment and personal details. Ask HR.';

  it.each([
    ['employmentEndDate', { employmentEndDate: '9999-12-31' }, `You can't change the employment end date${tail}`],
    ['employmentDate (cleared)', { employmentDate: '' }, `You can't change the employment start date${tail}`],
    ['dailyStandardHours', { dailyStandardHours: 9 }, `You can't change the daily standard hours${tail}`],
    ['taxId', { taxId: '987654321' }, `You can't change the tax ID${tail}`],
  ])('partners:write changing %s → 403, nothing written', async (_f, dto, message) => {
    const { svc, prisma } = makeService({ target: stored() });
    const err = await svc.update(50, dto as any, PARTNERS_WRITER).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionDeniedException);
    expect(err.message).toBe(message);
    expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', details: { module: 'hr', action: 'write' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('an Admin without hr cannot change personal fields either (several → all named)', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    const err = await svc.update(50, { address: 'Elsewhere 2', website: 'x.example' } as any, ADMIN).catch((e) => e);
    expect(err.message).toBe(`You can't change the address and the website${tail}`);
    expect(err.getResponse().details).toEqual({ module: 'hr', action: 'write', field: 'address', fields: ['address', 'website'] });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('echoing the stored values passes and they are dropped from the write', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    await svc.update(
      50,
      {
        firstName: 'Dana R.',
        employmentDate: '2024-03-01',
        employmentEndDate: '2027-12-31',
        dailyStandardHours: 8.4,
        employeeCategory: '',
        taxId: '123456789',
        address: 'Herzl 1, Tel Aviv',
      } as any,
      PARTNERS_WRITER,
    );
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ firstName: 'Dana R.' });
  });

  it('HR (hr:write) changes the employment end date', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    await svc.update(50, { employmentEndDate: '2026-12-31' } as any, HR);
    expect(prisma.user.update.mock.calls[0][0].data.employmentEndDate).toEqual(new Date('2026-12-31'));
  });

  it('the employee number (account tier) changes only for Admin or HR', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    await expect(svc.update(50, { code: 'E-999' } as any, PARTNERS_WRITER)).rejects.toThrow(
      "Only an Admin or HR can change a user's employee number.",
    );
    await svc.update(50, { code: 'E-100', firstName: 'Same code' } as any, PARTNERS_WRITER); // unchanged passes
    await svc.update(50, { code: 'E-999' } as any, HR);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
  });

  it('the PATCH response is shaped for the caller (partners:write gets no employment data back)', async () => {
    const { svc, prisma } = makeService({ target: stored() });
    await svc.update(50, { firstName: 'Dana R.' } as any, PARTNERS_WRITER);
    expect(prisma.user.update.mock.calls[0][0].select).toEqual({ id: true });
    const select = prisma.user.findFirst.mock.calls.at(-1)[0].select;
    expect(select).not.toHaveProperty('employmentDate');
    expect(select).not.toHaveProperty('code');
    expect(select.phone).toBe(true);
  });

  it('POST: an Admin without hr cannot set employment / personal fields; HR can', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.create({ ...createDto(5), employmentDate: '2026-12-01' } as any, ADMIN)).rejects.toThrow(
      `You can't change the employment start date${tail}`,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    // empty values are not a change
    await svc.create({ ...createDto(5), employmentDate: '', taxId: '' } as any, ADMIN);
    await svc.create({ ...createDto(5), employmentDate: '2026-12-01', employmentEndDate: '9999-12-31' } as any, HR);
    expect(prisma.user.create).toHaveBeenCalledTimes(2);
  });

  it('findPersonalFieldChanges normalises dates, decimals and empty strings', () => {
    const row = stored();
    expect(findPersonalFieldChanges({ employmentDate: '2024-03-01T00:00:00.000Z', dailyStandardHours: '8.4' }, row)).toEqual([]);
    expect(findPersonalFieldChanges({ dailyStandardHours: null }, row)).toEqual([]); // null is dropped (NOT NULL column)
    expect(findPersonalFieldChanges({ website: '' }, row)).toEqual([]);
    expect(findPersonalFieldChanges({ employmentEndDate: null, website: 'a.example' }, row)).toEqual([
      'employmentEndDate',
      'website',
    ]);
    expect(findPersonalFieldChanges({ employmentDate: '2026-01-01', firstName: 'x' }, null)).toEqual(['employmentDate']);
  });
});

describe('UsersService — round 3: subordinate cache invalidation', () => {
  it('clears the memo when the home org unit or the active state changes', async () => {
    const a = makeService();
    await a.svc.update(50, { orgUnitId: 99 } as any, HR);
    expect(a.projectAccess.invalidateSubordinateCache).toHaveBeenCalledWith();

    const b = makeService();
    await b.svc.update(50, { isActive: false } as any, HR);
    expect(b.projectAccess.invalidateSubordinateCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the memo alone for other edits (unchanged org unit included)', async () => {
    const { svc, projectAccess } = makeService();
    await svc.update(50, { firstName: 'Dana R.', orgUnitId: 10 } as any, HR);
    expect(projectAccess.invalidateSubordinateCache).not.toHaveBeenCalled();
  });

  it('clears the memo on create and on delete', async () => {
    const c = makeService();
    await c.svc.create({ ...createDto(5), orgUnitId: 10 } as any, HR);
    expect(c.projectAccess.invalidateSubordinateCache).toHaveBeenCalledTimes(1);

    const d = makeService();
    await d.svc.remove(50, HR);
    expect(d.projectAccess.invalidateSubordinateCache).toHaveBeenCalledTimes(1);
  });

  it('a refused write does not touch the memo', async () => {
    const { svc, projectAccess } = makeService();
    await expect(svc.update(50, { orgUnitId: 99 } as any, PARTNERS_WRITER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(projectAccess.invalidateSubordinateCache).not.toHaveBeenCalled();
  });
});

/**
 * Round 3 follow-up — the people directory (GET /users, GET /users/:id,
 * the labor-category history) opens to Admin, partners:read OR hr:read.
 * Checked by hand in the controller: `hr` is in NO_ADMIN_BYPASS, so a
 * `@RequirePermissions` naming it would lock Admins out, and decorator
 * entries are ANDed anyway.
 */
describe('UsersController — read gate: Admin, partners:read or hr:read', () => {
  const HR_ONLY = { id: 8, roleId: 10, isAdmin: false, roleModules: [perm('/hr', { canRead: true })] };
  const PARTNERS_READER = { id: 9, roleId: 11, isAdmin: false, roleModules: [perm('/partners', { canRead: true })] };
  const HR_NO_READ = { id: 10, roleId: 12, isAdmin: false, roleModules: [perm('/hr', { canRead: false })] };

  function makeCtrl() {
    const usersService: any = {
      findAll: jest.fn(async () => ({ data: [], meta: { total: 0 } })),
      findOne: jest.fn(async (id: number) => ({ id })),
    };
    const seniority: any = { listForUser: jest.fn(async () => []) };
    return { ctrl: new UsersController(usersService, seniority), usersService, seniority };
  }

  it('the read routes carry no @RequirePermissions (the guard would AND / drop the Admin bypass)', () => {
    for (const method of ['findAll', 'findOne', 'listSeniorities']) {
      expect(Reflect.getMetadata(ROLES_KEY, (UsersController.prototype as any)[method])).toBeUndefined();
    }
  });

  it.each([
    ['an HR-only caller (hr:read, no partners)', HR_ONLY],
    ['a partners:read caller', PARTNERS_READER],
    ['an Admin holding neither grant (Admin bypass, as for partners today)', ADMIN],
  ])('%s may open the list and a record', async (_label, actor) => {
    const { ctrl, usersService } = makeCtrl();
    await ctrl.findAll({} as any, actor);
    await ctrl.findOne(50, actor);
    expect(usersService.findAll).toHaveBeenCalledWith({}, actor);
    expect(usersService.findOne).toHaveBeenCalledWith(50, actor);
  });

  it.each([
    ['neither partners nor hr', NOBODY],
    ['an hr row without read', HR_NO_READ],
    ['no user', undefined],
  ])('a caller with %s gets 403 PERMISSION_DENIED and nothing is read', async (_label, actor) => {
    const { ctrl, usersService } = makeCtrl();
    for (const call of [() => ctrl.findAll({} as any, actor), () => ctrl.findOne(50, actor)]) {
      let err: any;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.message).toBe("You don't have permission to view people & contacts. Ask your administrator for access.");
      expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', details: { module: 'partners', action: 'read' } });
    }
    expect(usersService.findAll).not.toHaveBeenCalled();
    expect(usersService.findOne).not.toHaveBeenCalled();
  });

  it('the labor-category history uses the same gate (HR-only allowed, neither grant 403)', async () => {
    const { ctrl, seniority } = makeCtrl();
    await ctrl.listSeniorities(HR_ONLY, 50);
    expect(seniority.listForUser).toHaveBeenCalledWith(50);
    expect(() => ctrl.listSeniorities(NOBODY, 50)).toThrow(
      "You don't have permission to view people & contacts. Ask your administrator for access.",
    );
    // the user himself without partners / hr is stopped by the route gate
    expect(() => ctrl.listSeniorities(NOBODY, NOBODY.id)).toThrow(PermissionDeniedException);
  });
});

describe('UsersService — PATCH drops employerOrgId', () => {
  it('employerOrgId (create-only, not a User column) never reaches the Prisma update', async () => {
    const { svc, prisma } = makeService();
    await svc.update(50, { firstName: 'Dana R.', employerOrgId: 12 } as any, PARTNERS_WRITER);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ firstName: 'Dana R.' });
  });

  it('employerOrgId alone is a harmless no-op write', async () => {
    const { svc, prisma } = makeService();
    await svc.update(50, { employerOrgId: 12 } as any, HR);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
  });
});

describe('UsersService — PATCH drops businessPartnerId', () => {
  it('businessPartnerId (validated on create only) never reaches the Prisma update', async () => {
    const { svc, prisma } = makeService();
    await svc.update(50, { firstName: 'Dana R.', businessPartnerId: 999 } as any, PARTNERS_WRITER);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ firstName: 'Dana R.' });
  });

  it('not even an Admin can re-point the login at another partner through PATCH', async () => {
    const { svc, prisma } = makeService();
    await svc.update(50, { businessPartnerId: 999 } as any, ADMIN);
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('businessPartnerId');
  });
});
