// openid-client ships ESM only; the SSO service imports it at module
// load but the code paths tested here never call it.
jest.mock('openid-client', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { ActivityLogController } from './activity-log.controller';
import { RolesController } from './roles.controller';
import { AdminUsersController } from './users.controller';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { SsoAdminService } from '../sso-admin/sso-admin.service';
import { UsersController } from '../users/users.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

/**
 * Permissions round 1 (2026-11-20) — decision 3: an Admin may grant
 * himself finance / hr, provided every permission change is audited.
 * Audit rows use the new `security` category, which GET
 * /admin/activity-logs hides from everyone who is not an Admin
 * (81 "Department lead" users hold admin/activity-log:read on staging).
 */

const ADMIN = { id: 1, isAdmin: true, roleModules: [] as any[] };
const DEPT_LEAD = {
  id: 2,
  isAdmin: false,
  roleModules: [{ module: { route: '/admin/activity-log', name: 'Activity Log' }, canRead: true, canWrite: true }],
};
const ADMIN_WRITE_NON_ADMIN = {
  id: 3,
  isAdmin: false,
  roleModules: [{ module: { route: '/admin', name: 'Admin' }, canRead: true, canWrite: true }],
};

describe('GET /admin/activity-logs — security rows are Admin-only', () => {
  function make() {
    const prisma: any = {
      activityLog: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    };
    return { ctrl: new ActivityLogController(prisma), prisma };
  }
  const whereOf = (prisma: any) => prisma.activityLog.findMany.mock.calls[0][0].where;

  const NOT_SECURITY = [{ category: { not: 'security' } }];

  it('hides security rows from a non-admin reader', async () => {
    const { ctrl, prisma } = make();
    await ctrl.findAll(DEPT_LEAD);
    expect(whereOf(prisma).AND).toEqual(NOT_SECURITY);
    expect(prisma.activityLog.count.mock.calls[0][0].where.AND).toEqual(NOT_SECURITY);
  });

  it('category=security from a non-admin is ANDed with "not security" (matches nothing)', async () => {
    const { ctrl, prisma } = make();
    await ctrl.findAll(DEPT_LEAD, 1, 50, 'security');
    expect(whereOf(prisma)).toMatchObject({ category: 'security', AND: NOT_SECURITY });
  });

  it('a bracket-syntax category filter from a non-admin is still excluded', async () => {
    const { ctrl, prisma } = make();
    await ctrl.findAll(DEPT_LEAD, 1, 50, { in: ['security'] } as any);
    expect(whereOf(prisma)).toMatchObject({ category: { in: ['security'] }, AND: NOT_SECURITY });
  });

  it('leaves other explicit categories alone for a non-admin', async () => {
    const { ctrl, prisma } = make();
    await ctrl.findAll(DEPT_LEAD, 1, 50, 'auth');
    expect(whereOf(prisma)).toMatchObject({ category: 'auth', AND: NOT_SECURITY });
  });

  it('shows everything (and category=security) to an Admin', async () => {
    const { ctrl, prisma } = make();
    await ctrl.findAll(ADMIN);
    expect(whereOf(prisma).category).toBeUndefined();
    expect(whereOf(prisma).AND).toBeUndefined();
    await ctrl.findAll(ADMIN, 1, 50, 'security');
    expect(prisma.activityLog.findMany.mock.calls[1][0].where).toEqual({ category: 'security' });
  });
});

describe('ActivityLogService.logSecurityEvent', () => {
  it("writes category 'security' (default severity warn)", async () => {
    const prisma: any = { activityLog: { create: jest.fn(async () => ({})) } };
    const svc = new ActivityLogService(prisma);
    await svc.logSecurityEvent({ action: 'role.create', description: 'x', actorUserId: 1, entityType: 'role', entityId: 4 });
    const data = prisma.activityLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ category: 'security', severity: 'warn', action: 'role.create', userId: 1, entityId: 4 });
  });
});

describe('RolesController — role and grant changes are audited', () => {
  function make() {
    const prisma: any = {
      role: {
        create: jest.fn(async ({ data }: any) => ({ id: 12, ...data, roleModules: [] })),
        findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'Finance', description: 'old', isSystem: false })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, name: 'Finance', description: 'old', isSystem: false, ...data })),
        delete: jest.fn(),
      },
      roleModule: {
        findFirst: jest.fn(),
        update: jest.fn(async ({ data }: any) => ({ id: 70, ...data, module: { route: '/finance', name: 'Finance' } })),
        create: jest.fn(async ({ data }: any) => ({ id: 71, ...data, module: { route: '/hr', name: 'HR' } })),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      roleStageTransition: { deleteMany: jest.fn() },
      resourceOverride: { deleteMany: jest.fn() },
      $transaction: jest.fn(async () => []),
    };
    const activityLog: any = { logSecurityEvent: jest.fn(async () => undefined) };
    const ctrl = new RolesController(prisma, {} as any, {} as any, activityLog);
    return { ctrl, prisma, activityLog };
  }
  const entry = (activityLog: any, i = 0) => activityLog.logSecurityEvent.mock.calls[i][0];

  it('role create', async () => {
    const { ctrl, activityLog } = make();
    await ctrl.create({ name: 'Auditors' }, ADMIN);
    expect(entry(activityLog)).toMatchObject({ action: 'role.create', entityType: 'role', entityId: 12, actorUserId: 1 });
  });

  it('role update records before → after of touched fields', async () => {
    const { ctrl, activityLog } = make();
    await ctrl.update(12, { description: 'new' }, ADMIN);
    expect(entry(activityLog)).toMatchObject({
      action: 'role.update',
      changes: { description: { from: 'old', to: 'new' } },
    });
  });

  it('role delete', async () => {
    const { ctrl, activityLog } = make();
    await ctrl.remove(12, ADMIN);
    expect(entry(activityLog)).toMatchObject({ action: 'role.delete', entityId: 12, severity: 'critical' });
  });

  it('granting a new module (Admin grants himself hr) is audited', async () => {
    const { ctrl, prisma, activityLog } = make();
    prisma.roleModule.findFirst.mockResolvedValue(null);
    await ctrl.setModulePermission(1, { moduleId: 11, canRead: true, canWrite: true, canDelete: false }, ADMIN);
    expect(entry(activityLog)).toMatchObject({
      action: 'role.module_grant',
      actorUserId: 1,
      changes: {
        module: { id: 11, route: '/hr' },
        permissions: { from: null, to: { canRead: true, canWrite: true, canDelete: false, canApprove: false, canExport: false } },
      },
    });
  });

  it('changing a grant records before → after; a no-op save writes nothing', async () => {
    const { ctrl, prisma, activityLog } = make();
    const existing = { id: 70, roleId: 1, moduleId: 10, canRead: false, canWrite: false, canDelete: false, canApprove: false, canExport: false };
    prisma.roleModule.findFirst.mockResolvedValue(existing);
    await ctrl.setModulePermission(1, { moduleId: 10, canRead: true, canWrite: false, canDelete: false }, ADMIN);
    expect(entry(activityLog)).toMatchObject({
      action: 'role.module_change',
      changes: { permissions: { from: { canRead: false }, to: { canRead: true } } },
    });

    activityLog.logSecurityEvent.mockClear();
    prisma.roleModule.findFirst.mockResolvedValue({ ...existing, canRead: true });
    await ctrl.setModulePermission(1, { moduleId: 10, canRead: true, canWrite: false, canDelete: false }, ADMIN);
    expect(activityLog.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('revoking a module is audited', async () => {
    const { ctrl, prisma, activityLog } = make();
    prisma.roleModule.findFirst.mockResolvedValue({
      id: 70, canRead: true, canWrite: false, canDelete: false, canApprove: false, canExport: false,
      module: { route: '/finance', name: 'Finance' },
    });
    await ctrl.removeModulePermission(1, 10, ADMIN);
    expect(entry(activityLog)).toMatchObject({
      action: 'role.module_revoke',
      changes: { permissions: { from: { canRead: true }, to: null } },
    });
  });
});

describe('PATCH /admin/users/:id/roles — Admin only, audited', () => {
  function make() {
    const roster = { current: [{ role: { id: 5, name: 'Employee' } }] as any[] };
    const prisma: any = {
      user: {
        findFirst: jest.fn(async ({ select }: any) => {
          if (select?.email) {
            return { id: 50, email: 'dana@x.com', userRoles: roster.current.map((ur) => ({ roleId: ur.role.id, role: ur.role })) };
          }
          return {
            id: 50,
            roleId: 5,
            role: { id: 5, name: 'Employee', isSystem: true },
            userRoles: roster.current.map((ur) => ({
              role: { ...ur.role, isSystem: true, description: null },
              grantedAt: new Date('2026-11-20T00:00:00Z'),
              grantedById: 1,
            })),
          };
        }),
      },
      role: { findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: number) => ({ id }))) },
      $transaction: jest.fn(async () => {
        roster.current = [{ role: { id: 5, name: 'Employee' } }, { role: { id: 8, name: 'Finance' } }];
      }),
    };
    const activityLog: any = { logSecurityEvent: jest.fn(async () => undefined) };
    return { ctrl: new AdminUsersController(prisma, activityLog), prisma, activityLog };
  }

  it('a non-admin with admin:write can no longer change roles', async () => {
    const { ctrl, prisma } = make();
    await expect(ctrl.patchRoles(50, { addRoleIds: [8] }, ADMIN_WRITE_NON_ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an Admin granting a role writes a security row with before → after', async () => {
    const { ctrl, activityLog } = make();
    await ctrl.patchRoles(50, { addRoleIds: [8] }, ADMIN);
    expect(activityLog.logSecurityEvent.mock.calls[0][0]).toMatchObject({
      action: 'user.roles_change',
      actorUserId: 1,
      entityId: 50,
      changes: {
        roles: { from: [{ id: 5, name: 'Employee' }], to: [{ id: 5, name: 'Employee' }, { id: 8, name: 'Finance' }] },
        added: [{ id: 8, name: 'Finance' }],
        removed: [],
      },
    });
  });
});

describe('SSO config changes are security rows', () => {
  it('enable/disable writes category security with before → after', async () => {
    const row = {
      id: 1, provider: 'microsoft', enabled: false, tenantId: 't', clientId: 'c',
      secretCiphertext: Buffer.from('x'), allowedDomains: 'amec.co.il', defaultRoleId: 5, ssoOnly: false,
      keyVersion: 1, updatedAt: new Date(),
    };
    const prisma: any = {
      orgAuthConfig: {
        findFirst: jest.fn(async () => row),
        update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
      },
    };
    const activity: any = { write: jest.fn(async () => undefined) };
    const crypto: any = { fingerprint: () => 'abcd' };
    const svc = new SsoAdminService(prisma, crypto, activity);

    await svc.setEnabled('microsoft', true, 1, null);

    const call = activity.write.mock.calls[0][0];
    expect(call.category).toBe('security');
    expect(call.changes).toEqual({ enabled: { from: false, to: true } });
    expect(JSON.stringify(call)).not.toContain('secretCiphertext');
  });
});

describe('POST/PATCH/DELETE /users no longer depend on partners:* in the guard', () => {
  it.each(['create', 'update', 'remove'])('%s has no @RequirePermissions (checked in UsersService)', (method) => {
    expect(Reflect.getMetadata(ROLES_KEY, (UsersController.prototype as any)[method])).toBeUndefined();
  });
});
