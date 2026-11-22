import { HrService } from './hr.service';
import { HrController } from './hr.controller';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

/**
 * Permissions round 3 (2026-11-22) — HR audit rows get their own
 * category (`hr`), readable only by hr:read holders through GET
 * /hr/audit, and the HR actions that wrote nothing before (employee HR
 * fields, eligibilities) are now audited.
 *
 * HrService.writeAudit is fire-and-forget, so every assertion waits a
 * macrotask (`flush`) for the ActivityLogService call to land.
 */

const flush = () => new Promise((r) => setImmediate(r));

function makeService(prismaOverrides: Record<string, any> = {}) {
  const create = jest.fn(async () => ({}));
  const prisma: any = {
    activityLog: {
      create,
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
    specialHourBucket: { findUnique: jest.fn() },
    employeeBucketEligibility: {
      findFirst: jest.fn(),
      findMany: jest.fn(async () => []),
      create: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    hrSettings: { findUnique: jest.fn(), update: jest.fn() },
    ...prismaOverrides,
  };
  const activityLog = new ActivityLogService(prisma);
  const config: any = { get: (_k: string, d?: string) => d };
  const svc = new HrService(prisma, {} as any, activityLog, config);
  return { svc, prisma, create };
}

const auditRows = (create: jest.Mock) => create.mock.calls.map((c: any[]) => c[0].data);

describe('HrService.writeAudit — category hr', () => {
  it("existing HR writes (settings) now land in category 'hr', not 'admin'", async () => {
    const { svc, prisma, create } = makeService();
    prisma.hrSettings.update.mockResolvedValue({ id: 1, minHoursPerDay: 5, updatedAt: new Date() });
    prisma.hrSettings.findUnique.mockResolvedValue({ id: 1 });
    await svc.updateSettings({ minHoursPerDay: 5 } as any, 9);
    await flush();
    const [row] = auditRows(create);
    expect(row).toMatchObject({ category: 'hr', action: 'hr.settings.updated', userId: 9 });
  });

  it('a failing audit write never fails the HR write', async () => {
    const { svc, prisma, create } = makeService();
    create.mockRejectedValue(new Error('table full'));
    prisma.hrSettings.update.mockResolvedValue({ id: 1, minHoursPerDay: 5, updatedAt: new Date() });
    prisma.hrSettings.findUnique.mockResolvedValue({ id: 1 });
    await expect(svc.updateSettings({ minHoursPerDay: 5 } as any, 9)).resolves.toBeDefined();
    await flush();
  });
});

describe('HrService.updateEmployee — audited', () => {
  const existing = {
    id: 42,
    firstName: 'Dana',
    lastName: 'Levi',
    employmentType: 'HOURLY',
    accountingEmployeeNumber: 'P-100',
    dailyStandardHours: { toNumber: () => 8.4 },
    employmentDate: new Date('2024-01-01T00:00:00Z'),
    employmentEndDate: null,
  };

  it('records which fields changed; the payroll number without its value', async () => {
    const { svc, prisma, create } = makeService();
    prisma.user.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce({
      ...existing,
      bucketEligibilities: [],
      dailyStandardHours: 9,
    });
    await svc.updateEmployee(
      42,
      { employmentType: 'GLOBAL', accountingEmployeeNumber: 'P-200', dailyStandardHours: 9, employmentDate: '2024-01-01' } as any,
      7,
    );
    await flush();
    const [row] = auditRows(create);
    expect(row).toMatchObject({
      category: 'hr',
      action: 'hr.employee.updated',
      entityType: 'employee',
      entityId: 42,
      userId: 7,
      metadata: { employeeId: 42 },
    });
    expect(row.changes).toEqual({
      employmentType: { from: 'HOURLY', to: 'GLOBAL' },
      accountingEmployeeNumber: 'changed',
      dailyStandardHours: { from: 8.4, to: 9 },
    });
    // The unchanged employment date is not reported; no payroll value leaks.
    expect(JSON.stringify(row)).not.toContain('P-200');
    expect(JSON.stringify(row)).not.toContain('P-100');
  });

  it('writes no audit row for a no-op save', async () => {
    const { svc, prisma, create } = makeService();
    prisma.user.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, bucketEligibilities: [] });
    await svc.updateEmployee(42, { employmentType: 'HOURLY' } as any, 7);
    await flush();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('HrService eligibilities — audited', () => {
  const bucket = { id: 3, code: 'B_TRAVEL', nameHe: 'נסיעות', dailyAmount: { toNumber: () => 1 }, minDailyStandard: null };

  it('create', async () => {
    const { svc, prisma, create } = makeService();
    prisma.user.findFirst.mockResolvedValue({ id: 42, dailyStandardHours: 8.4, firstName: 'Dana', lastName: 'Levi' });
    prisma.specialHourBucket.findUnique.mockResolvedValue({ ...bucket, dailyAmount: 1 });
    prisma.employeeBucketEligibility.create.mockResolvedValue({ id: 77, dailyAmount: 1, bucket: null });
    await svc.createEligibility(42, 7, { bucketId: 3, startDate: '2026-01-01', endDate: '2026-12-31' } as any);
    await flush();
    const [row] = auditRows(create);
    expect(row).toMatchObject({
      category: 'hr',
      action: 'hr.eligibility.created',
      entityType: 'bucket_eligibility',
      entityId: 77,
      userId: 7,
      metadata: { employeeId: 42 },
      changes: { bucket: 'B_TRAVEL', dailyAmount: 1, startDate: '2026-01-01', endDate: '2026-12-31' },
    });
  });

  it('update records before → after of what changed', async () => {
    const { svc, prisma, create } = makeService();
    prisma.user.findFirst.mockResolvedValue({ id: 42 }); // listEligibilities' employee check
    prisma.employeeBucketEligibility.findFirst.mockResolvedValue({
      id: 77,
      userId: 42,
      dailyAmount: { toNumber: () => 1 },
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: new Date('2026-12-31T00:00:00Z'),
      creditMode: null,
      documentFileId: null,
      active: true,
      bucket: { code: 'B_TRAVEL', nameHe: 'נסיעות' },
    });
    await svc.updateEligibility(42, 77, { dailyAmount: 2, creditMode: 'AUTO' } as any, 7);
    await flush();
    const [row] = auditRows(create);
    expect(row).toMatchObject({
      action: 'hr.eligibility.updated',
      entityId: 77,
      userId: 7,
      metadata: { employeeId: 42 },
      changes: { dailyAmount: { from: 1, to: 2 }, creditMode: { from: null, to: 'AUTO' } },
    });
  });

  it('deactivate', async () => {
    const { svc, prisma, create } = makeService();
    prisma.employeeBucketEligibility.findFirst.mockResolvedValue({ id: 77, userId: 42, active: true, bucket });
    await svc.deactivateEligibility(42, 77, 7);
    await flush();
    const [row] = auditRows(create);
    expect(row).toMatchObject({
      category: 'hr',
      action: 'hr.eligibility.deactivated',
      severity: 'warn',
      userId: 7,
      metadata: { employeeId: 42 },
      changes: { active: { from: true, to: false } },
    });
  });
});

describe('GET /hr/audit', () => {
  it('is gated hr:read (hr has no admin bypass in the RolesGuard)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, HrController.prototype.listAudit)).toEqual([
      { module: 'hr', action: 'read' },
    ]);
  });

  it('lists only category hr, newest first, with the filters applied', async () => {
    const { svc, prisma } = makeService();
    prisma.activityLog.findMany.mockResolvedValue([
      {
        id: BigInt(5),
        createdAt: new Date('2026-11-20T10:00:00Z'),
        action: 'hr.absence.created',
        severity: 'info',
        entityType: 'absence_record',
        entityId: 9,
        entityName: 'מחלה',
        description: 'Logged absence',
        changes: null,
        metadata: { employeeId: 42 },
        user: { id: 7, firstName: 'Hila', lastName: 'HR' },
      },
    ]);
    prisma.activityLog.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([{ id: 42, firstName: 'Dana', lastName: 'Levi' }]);

    const res = await svc.listAudit({
      page: 2,
      perPage: 10,
      from: '2026-11-01',
      to: '2026-11-30',
      action: 'hr.absence',
      actorId: 7,
      employeeId: 42,
    });

    const args = prisma.activityLog.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      category: 'hr',
      createdAt: { gte: new Date('2026-11-01'), lt: new Date('2026-12-01') },
      action: { startsWith: 'hr.absence' },
      userId: 7,
      metadata: { path: '$.employeeId', equals: 42 },
    });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(res.meta).toEqual({ total: 1, page: 2, perPage: 10, totalPages: 1 });
    expect(res.data[0]).toMatchObject({
      id: '5',
      action: 'hr.absence.created',
      actor: { id: 7, firstName: 'Hila' },
      employee: { id: 42, firstName: 'Dana', lastName: 'Levi' },
    });
  });

  it('caps perPage and defaults to the hr category only', async () => {
    const { svc, prisma } = makeService();
    await svc.listAudit({ perPage: 5000 });
    const args = prisma.activityLog.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ category: 'hr' });
    expect(args.take).toBe(200);
  });

  it('rejects a malformed date', async () => {
    const { svc } = makeService();
    await expect(svc.listAudit({ from: 'not-a-date' })).rejects.toThrow('"from" must be a date');
  });
});
