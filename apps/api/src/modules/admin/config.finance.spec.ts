/**
 * Permissions round 2 (2026-11-20) — B-06 / B-14: the labor-category
 * (seniority level) and rate routes in `admin/config` need the finance
 * grant on top of `admin:*`: reads `finance:read`, changes
 * `finance:write`. Admins are NOT bypassed (finance is in
 * NO_ADMIN_BYPASS); the `admin` half keeps its decorator + bypass.
 * The seniority-history writes on `/users/:id/seniorities` (they move an
 * employee's cost tier) need `finance:write` too.
 */
import { ForbiddenException } from '@nestjs/common';

import { ConfigController } from './config.controller';
import { UsersController } from '../users/users.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

const finance = (flags: Record<string, boolean>) => ({ module: { route: '/finance', name: 'Finance' }, ...flags });
const ADMIN_NO_FINANCE = { id: 1, isAdmin: true, roleModules: [] as any[] };
const ADMIN_FINANCE_READ = { id: 1, isAdmin: true, roleModules: [finance({ canRead: true })] };
const ADMIN_FINANCE_WRITE = { id: 1, isAdmin: true, roleModules: [finance({ canRead: true, canWrite: true })] };

function makePrisma() {
  const tx: any = {
    seniorityRate: { updateMany: jest.fn(async () => ({ count: 0 })), create: jest.fn(async () => ({ id: 1 })) },
    userRate: { updateMany: jest.fn(async () => ({ count: 0 })), create: jest.fn(async () => ({ id: 1 })) },
  };
  return {
    seniorityLevel: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async () => ({ id: 1 })),
      update: jest.fn(async () => ({ id: 1 })),
      delete: jest.fn(async () => ({ id: 1 })),
      findFirstOrThrow: jest.fn(async () => ({ id: 1 })),
    },
    seniorityRate: { findMany: jest.fn(async () => []) },
    userRate: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
    user: { findFirstOrThrow: jest.fn(async () => ({ id: 7 })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as any;
}

const READS: Array<[string, (c: ConfigController, u: any) => Promise<unknown>]> = [
  ['GET seniority-levels', (c, u) => c.getSeniorityLevels(u)],
  ['GET seniority-levels/:id/rates', (c, u) => c.getSeniorityRates(u, 1)],
  ['GET user-rates/:userId', (c, u) => c.getUserRates(u, 7)],
];

const WRITES: Array<[string, (c: ConfigController, u: any) => Promise<unknown>]> = [
  ['POST seniority-levels', (c, u) => c.createSeniorityLevel(u, { code: 'SR', name: 'Senior', defaultHourlyCost: 200 })],
  ['PATCH seniority-levels/:id', (c, u) => c.updateSeniorityLevel(u, 1, { name: 'Senior II' })],
  ['DELETE seniority-levels/:id', (c, u) => c.deleteSeniorityLevel(u, 1)],
  ['POST seniority-levels/:id/rates/change', (c, u) => c.changeSeniorityRate(u, 1, { hourlyCost: 210, effectiveFrom: '2026-12-01' })],
  ['POST user-rates/:userId/change', (c, u) => c.changeUserRate(u, 7, { hourlyCost: 250, effectiveFrom: '2026-12-01' })],
  ['DELETE user-rates/:userId/current', (c, u) => c.removeUserRate(u, 7, { effectiveFrom: '2026-12-01' })],
];

describe('admin/config rate routes need finance (B-06 / B-14)', () => {
  it.each(READS)('%s — 403 for an Admin without finance:read, OK with it', async (_name, call) => {
    const prisma = makePrisma();
    const ctrl = new ConfigController(prisma);
    await expect(call(ctrl, ADMIN_NO_FINANCE)).rejects.toThrow(ForbiddenException);
    await expect(call(ctrl, ADMIN_FINANCE_READ)).resolves.toBeDefined();
  });

  it.each(WRITES)('%s — 403 without finance:write (finance:read is not enough), OK with it', async (_name, call) => {
    const prisma = makePrisma();
    const ctrl = new ConfigController(prisma);
    await expect(call(ctrl, ADMIN_NO_FINANCE)).rejects.toThrow(ForbiddenException);
    await expect(call(ctrl, ADMIN_FINANCE_READ)).rejects.toThrow(
      "You don't have permission to change financial data. Ask your administrator for access.",
    );
    expect(prisma.seniorityLevel.create).not.toHaveBeenCalled();
    expect(prisma.seniorityLevel.update).not.toHaveBeenCalled();
    expect(prisma.seniorityLevel.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.userRate.updateMany).not.toHaveBeenCalled();
    await expect(call(ctrl, ADMIN_FINANCE_WRITE)).resolves.toBeDefined();
  });

  it('the admin half stays on the decorator (so the Admin bypass still applies to it)', () => {
    const proto = ConfigController.prototype as any;
    expect(Reflect.getMetadata(ROLES_KEY, proto.getSeniorityLevels)).toEqual([{ module: 'admin', action: 'read' }]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.changeUserRate)).toEqual([{ module: 'admin', action: 'write' }]);
  });
});

describe('/users/:id/seniorities writes need finance:write (B-14)', () => {
  const PARTNERS_WRITER = {
    id: 2,
    isAdmin: false,
    roleModules: [{ module: { route: '/partners', name: 'partners' }, canRead: true, canWrite: true, canDelete: true }],
  };
  const PARTNERS_FINANCE_WRITER = {
    ...PARTNERS_WRITER,
    roleModules: [...PARTNERS_WRITER.roleModules, finance({ canRead: true, canWrite: true })],
  };

  function make() {
    const seniority: any = {
      listForUser: jest.fn(async () => []),
      addEntry: jest.fn(async () => ({ id: 1 })),
      updateEntry: jest.fn(async () => ({ id: 1 })),
      removeEntry: jest.fn(async () => ({ id: 1 })),
    };
    return { ctrl: new UsersController({} as any, seniority), seniority };
  }

  it('add / update / remove → 403 without finance:write; nothing written', async () => {
    const { ctrl, seniority } = make();
    expect(() => ctrl.addSeniority(PARTNERS_WRITER, 7, { seniorityLevelId: 2, startDate: '2026-12-01' } as any)).toThrow(
      ForbiddenException,
    );
    expect(() => ctrl.updateSeniority(PARTNERS_WRITER, 7, 1, {} as any)).toThrow(ForbiddenException);
    expect(() => ctrl.removeSeniority(PARTNERS_WRITER, 7, 1)).toThrow(ForbiddenException);
    expect(() => ctrl.addSeniority(ADMIN_NO_FINANCE, 7, {} as any)).toThrow(ForbiddenException);
    expect(seniority.addEntry).not.toHaveBeenCalled();
    expect(seniority.updateEntry).not.toHaveBeenCalled();
    expect(seniority.removeEntry).not.toHaveBeenCalled();
  });

  it('a finance writer may move the tier', async () => {
    const { ctrl, seniority } = make();
    await ctrl.addSeniority(PARTNERS_FINANCE_WRITER, 7, { seniorityLevelId: 2, startDate: '2026-12-01' } as any);
    expect(seniority.addEntry).toHaveBeenCalled();
  });

  it('the read stays on partners:read (its level cost is removed by the interceptor)', async () => {
    const { ctrl, seniority } = make();
    await ctrl.listSeniorities(7);
    expect(seniority.listForUser).toHaveBeenCalledWith(7);
  });
});
