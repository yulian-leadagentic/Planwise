/**
 * QA6 P7 (PR-056) — POST /admin/backfills/qa6-operations-grants:
 * dry-run by default (writes nothing, lists the role ids / names and the
 * names it could not find), the real run grants, a second run grants 0.
 */
import { Qa6OperationsGrantsService, parseQa6OperationsGrantsBody } from './qa6-operations-grants.service';
import { Qa6OperationsGrantsController } from './qa6-operations-grants.controller';

type Mod = { id: number; name: string; route: string };
type Role = { id: number; name: string };
type RM = { id: number; roleId: number; moduleId: number; canRead: boolean; canWrite: boolean; canDelete: boolean; canApprove: boolean; canExport: boolean };

/** Tiny in-memory Prisma: names compare case-insensitively, like MySQL. */
function fakeDb(opts: { modules?: Mod[]; roles?: Role[]; roleModules?: RM[] } = {}) {
  const db = {
    modules: [...(opts.modules ?? [{ id: 31, name: 'Operations', route: '/operations' }])],
    roles: [...(opts.roles ?? [
      { id: 1, name: 'Admin' },
      { id: 7, name: 'Depatment lead' },
      { id: 9, name: 'BIM leader' },
      { id: 12, name: 'Professonal' },
      { id: 13, name: 'Employee' },
    ])],
    roleModules: [...(opts.roleModules ?? [])],
  };
  let nextId = 1000;
  const writes = { count: 0 };
  const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const prisma: any = {
    module: {
      findFirst: jest.fn(async ({ where }: any) =>
        db.modules.find((m) => where.OR.some((c: any) => (c.route && m.route === c.route) || (c.name && ci(m.name, c.name)))) ?? null),
      create: jest.fn(async ({ data }: any) => { writes.count++; const m = { id: nextId++, ...data }; db.modules.push(m); return m; }),
    },
    role: {
      findMany: jest.fn(async ({ where }: any) => db.roles.filter((r) => where.name.in.some((n: string) => ci(n, r.name)))),
    },
    roleModule: {
      findMany: jest.fn(async ({ where }: any) => db.roleModules.filter((x) => x.moduleId === where.moduleId && where.roleId.in.includes(x.roleId))),
      create: jest.fn(async ({ data }: any) => { writes.count++; const r = { id: nextId++, ...data }; db.roleModules.push(r); return r; }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        writes.count++;
        const rows = db.roleModules.filter((x) => where.id.in.includes(x.id));
        rows.forEach((x) => Object.assign(x, data));
        return { count: rows.length };
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const activityLog: any = { logSecurityEvent: jest.fn(async () => undefined) };
  return { db, prisma, activityLog, writes, svc: new Qa6OperationsGrantsService(prisma, activityLog) };
}

describe('qa6-operations-grants backfill', () => {
  it('dry-run is the default: nothing written, the plan lists ids, names and what is missing', async () => {
    const { svc, writes, activityLog, db } = fakeDb({ roles: [{ id: 1, name: 'Admin' }, { id: 9, name: 'BIM leader' }, { id: 12, name: 'Professonal' }] });
    const out = await svc.run({ dryRun: parseQa6OperationsGrantsBody(undefined).dryRun });
    expect(out.dryRun).toBe(true);
    expect(out.roles).toEqual([
      { roleId: 1, roleName: 'Admin', action: 'create' },
      { roleId: 9, roleName: 'BIM leader', action: 'create' },
    ]);
    expect(out.notFound).toEqual(['Depatment lead']);
    expect(out.granted).toBe(2);
    expect(out.module).toMatchObject({ id: 31, route: '/operations', missing: false, created: false });
    expect(writes.count).toBe(0);
    expect(db.roleModules).toHaveLength(0);
    expect(activityLog.logSecurityEvent).not.toHaveBeenCalled();
  });

  it('only the boolean false writes', () => {
    expect(parseQa6OperationsGrantsBody({}).dryRun).toBe(true);
    expect(parseQa6OperationsGrantsBody({ dryRun: 'false' }).dryRun).toBe(true);
    expect(parseQa6OperationsGrantsBody({ dryRun: 0 }).dryRun).toBe(true);
    expect(parseQa6OperationsGrantsBody({ dryRun: false }).dryRun).toBe(false);
  });

  it('the real run grants read only, to the three named roles, and audits each grant; a second run grants 0', async () => {
    const { svc, db, activityLog } = fakeDb();
    const first = await svc.run({ dryRun: false, actorId: 1 });
    expect(first.granted).toBe(3);
    expect(first.notFound).toEqual([]);
    expect(db.roleModules.map((r) => r.roleId).sort((a, b) => a - b)).toEqual([1, 7, 9]);
    expect(db.roleModules.every((r) => r.moduleId === 31 && r.canRead && !r.canWrite && !r.canDelete && !r.canApprove && !r.canExport)).toBe(true);
    // Professonal (12) and Employee (13) get nothing
    expect(db.roleModules.some((r) => r.roleId === 12 || r.roleId === 13)).toBe(false);
    expect(activityLog.logSecurityEvent).toHaveBeenCalledTimes(3);
    expect(activityLog.logSecurityEvent.mock.calls[0][0]).toMatchObject({ action: 'role.module_grant', entityType: 'role', actorUserId: 1 });

    const second = await svc.run({ dryRun: false, actorId: 1 });
    expect(second.granted).toBe(0);
    expect(second.roles.every((r) => r.action === 'already')).toBe(true);
    expect(db.roleModules).toHaveLength(3);
    expect(activityLog.logSecurityEvent).toHaveBeenCalledTimes(3);
  });

  it('a row with read switched off is switched on (other flags kept); exact names only', async () => {
    const { svc, db } = fakeDb({
      roles: [{ id: 7, name: 'Depatment lead' }, { id: 8, name: 'Department Lead' }, { id: 10, name: 'bim leader' }],
      roleModules: [{ id: 50, roleId: 7, moduleId: 31, canRead: false, canWrite: false, canDelete: false, canApprove: false, canExport: true }],
    });
    const out = await svc.run({ dryRun: false });
    expect(out.roles).toEqual([{ roleId: 7, roleName: 'Depatment lead', action: 'enable-read' }]);
    // 'bim leader' (lower case) and 'Department Lead' are not the roles named exactly
    expect(out.notFound).toEqual(['Admin', 'BIM leader']);
    expect(db.roleModules).toEqual([expect.objectContaining({ id: 50, canRead: true, canExport: true })]);
  });

  it('a missing module row is planned on the dry-run and created on the real run', async () => {
    const dry = fakeDb({ modules: [] });
    const plan = await dry.svc.run({ dryRun: true });
    expect(plan.module).toMatchObject({ id: null, missing: true, created: false });
    expect(dry.writes.count).toBe(0);

    const real = fakeDb({ modules: [] });
    const out = await real.svc.run({ dryRun: false });
    expect(out.module).toMatchObject({ missing: true, created: true });
    expect(real.db.modules).toEqual([expect.objectContaining({ name: 'Operations', route: '/operations' })]);
    expect(real.db.roleModules.every((r) => r.moduleId === out.module.id)).toBe(true);
  });

  it('the endpoint defaults to a dry-run and passes the actor', async () => {
    const grants: any = { run: jest.fn(async () => ({})) };
    const ctrl = new Qa6OperationsGrantsController(grants);
    await ctrl.run({ id: 5 }, undefined);
    expect(grants.run).toHaveBeenCalledWith({ dryRun: true, actorId: 5 });
    await ctrl.run({ id: 5 }, { dryRun: false });
    expect(grants.run).toHaveBeenLastCalledWith({ dryRun: false, actorId: 5 });
  });
});
