/**
 * Permissions round 3 — privacy (2026-11-22): attendance (clock
 * records) and timesheets (time entries) of another employee.
 *
 *   VIEW    — self | hr:read | manager chain (unit or any ancestor).
 *   EDIT    — hr:write | chain; never one's own record; clears approval.
 *   APPROVE — hr:approve | chain; never one's own record; 404 if missing.
 *   Project leader — entries on HIS projects only, without location /
 *   special-hours bucket / clock data.
 *   Admin without hr — no exception anywhere.
 *
 * The rules run through the real EmployeeScopeService on top of an
 * in-memory org tree:
 *
 *   unit 1  /1/      manager 99 (CEO)
 *   unit 5  /1/5/    manager 20 (MANAGER)     member 21
 *   unit 7  /1/5/7/  manager 21 (TEAM_LEAD)   member 30 (EMPLOYEE)
 *   project 59 — leader 50 (LEADER)
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { EmployeeScopeService } from '../../common/services/employee-scope.service';
import { TimeClockController } from './time-clock.controller';
import { TimeClockService } from './time-clock.service';
import { TimeEntriesController } from './time-entries.controller';
import { TimeEntriesService } from './time-entries.service';

const perm = (route: string, flags: Record<string, boolean>) => ({ module: { route, name: route.slice(1) }, ...flags });
const TIME_RW = perm('/time', { canRead: true, canWrite: true });

const HR = {
  id: 10,
  isAdmin: false,
  roleModules: [perm('/hr', { canRead: true, canWrite: true, canApprove: true }), perm('/time', { canRead: true })],
};
/** Chain manager holding only the default Employee preset (time read + write, no approve). */
const MANAGER = { id: 20, isAdmin: false, roleModules: [TIME_RW] };
/** Manager preset (time read + approve, no write). */
const TEAM_LEAD = { id: 21, isAdmin: false, roleModules: [perm('/time', { canRead: true, canApprove: true })] };
const EMPLOYEE = { id: 30, isAdmin: false, roleModules: [TIME_RW] };
/** Not in the chain — even time:approve doesn't help. */
const STRANGER = { id: 40, isAdmin: false, roleModules: [perm('/time', { canRead: true, canWrite: true, canApprove: true })] };
const LEADER = { id: 50, isAdmin: false, roleModules: [TIME_RW] };
/** Admin with every module except HR. */
const ADMIN = {
  id: 1,
  isAdmin: true,
  roleModules: [perm('/time', { canRead: true, canWrite: true, canApprove: true }), perm('/admin', { canRead: true })],
};

function makeOrgPrisma() {
  const units = [
    { id: 1, path: '/1/', managerUserId: 99, deletedAt: null },
    { id: 5, path: '/1/5/', managerUserId: 20, deletedAt: null },
    { id: 7, path: '/1/5/7/', managerUserId: 21, deletedAt: null },
  ];
  const users = [
    { id: 99, orgUnitId: 1 },
    { id: 20, orgUnitId: 1 },
    { id: 21, orgUnitId: 5 },
    { id: 30, orgUnitId: 7 },
    { id: 40, orgUnitId: 1 },
    { id: 50, orgUnitId: 1 },
    { id: 10, orgUnitId: null },
    { id: 1, orgUnitId: null },
  ];
  const projects = [{ id: 59, leaderId: 50 }];
  const unit = (id: number | null) => units.find((u) => u.id === id);
  return {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) return null;
        return { orgUnitId: u.orgUnitId, orgUnit: u.orgUnitId ? { path: unit(u.orgUnitId)!.path } : null };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        users
          .filter((u) => where.orgUnitId.in.includes(u.orgUnitId) && u.id !== where.id?.not)
          .map((u) => ({ id: u.id })),
      ),
    },
    orgUnit: {
      count: jest.fn(async ({ where }: any) =>
        units.filter((u) => where.id.in.includes(u.id) && u.managerUserId === where.managerUserId && !u.deletedAt).length,
      ),
      findMany: jest.fn(async ({ where }: any) => {
        if (where.managerUserId != null) {
          return units.filter((u) => u.managerUserId === where.managerUserId && !u.deletedAt).map((u) => ({ id: u.id, path: u.path }));
        }
        return units
          .filter((u) =>
            where.OR.some((c: any) => (c.id && c.id.in.includes(u.id)) || (c.path && u.path.startsWith(c.path.startsWith))),
          )
          .map((u) => ({ id: u.id }));
      }),
    },
    project: {
      findMany: jest.fn(async ({ where }: any) => projects.filter((p) => p.leaderId === where.leaderId).map((p) => ({ id: p.id }))),
      findFirst: jest.fn(async ({ where }: any) => projects.find((p) => p.id === where.id) ?? null),
    },
  };
}

async function denial(promise: Promise<unknown>): Promise<any> {
  const err: any = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ForbiddenException);
  return err.getResponse();
}

// ─── Time clock ────────────────────────────────────────────────────────

function makeClock(record: any = { id: 500, userId: 30 }) {
  const org = makeOrgPrisma();
  const prisma: any = {
    ...org,
    timeClock: {
      findUnique: jest.fn(async ({ where }: any) => (record && where.id === record.id ? { breakMinutes: 0, expectedMinutes: null, clockIn: new Date('2026-11-22T06:00:00Z'), clockOut: null, ...record } : null)),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ data }: any) => ({ ...record, ...data })),
      create: jest.fn(async ({ data }: any) => ({ id: 900, ...data })),
      count: jest.fn(async () => 0),
    },
    workSchedule: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  };
  const activityLog: any = { write: jest.fn(async () => undefined) };
  const scope = new EmployeeScopeService(prisma);
  const service = new TimeClockService(prisma, activityLog, scope);
  const controller = new TimeClockController(service, scope);
  return { prisma, activityLog, scope, service, controller };
}

describe('TimeClockController — route gates', () => {
  const proto = TimeClockController.prototype as any;
  it.each(['edit', 'approve', 'markAbsent', 'getTeamDashboardToday', 'getHistory'])(
    '%s only needs the time:read baseline (the service decides)',
    (handler) => {
      expect(Reflect.getMetadata(ROLES_KEY, proto[handler])).toEqual([{ module: 'time', action: 'read' }]);
    },
  );
});

describe('GET /time-clock/team-today — visible employees only', () => {
  it('a manager sees himself + his subtree, the "not yet" list included', async () => {
    const { controller, prisma } = makeClock();
    const out: any = await controller.getTeamDashboardToday(MANAGER);
    const recWhere = prisma.timeClock.findMany.mock.calls[0][0].where;
    const schedWhere = prisma.workSchedule.findMany.mock.calls[0][0].where;
    expect([...recWhere.userId.in].sort()).toEqual([20, 21, 30]);
    expect([...schedWhere.userId.in].sort()).toEqual([20, 21, 30]);
    expect(out.scope).toEqual({ allEmployees: false, visibleOthers: 2 });
  });

  it('hr:read sees everyone (no user filter)', async () => {
    const { controller, prisma } = makeClock();
    const out: any = await controller.getTeamDashboardToday(HR);
    expect(prisma.timeClock.findMany.mock.calls[0][0].where.userId).toBeUndefined();
    expect(prisma.workSchedule.findMany.mock.calls[0][0].where.userId).toBeUndefined();
    expect(out.scope).toEqual({ allEmployees: true, visibleOthers: null });
  });

  it('an admin without hr / a non-manager sees only himself (empty-state signal)', async () => {
    for (const caller of [ADMIN, STRANGER]) {
      const { controller, prisma } = makeClock();
      const out: any = await controller.getTeamDashboardToday(caller);
      expect(prisma.timeClock.findMany.mock.calls[0][0].where.userId).toEqual({ in: [caller.id] });
      expect(out.scope).toEqual({ allEmployees: false, visibleOthers: 0 });
    }
  });

  it('the service alone (no scope passed) shows nobody', async () => {
    const { service, prisma } = makeClock();
    const out: any = await service.getTeamDashboardToday();
    expect(out).toMatchObject({ clockedIn: [], notYet: [], late: [], onLeave: [] });
    expect(prisma.timeClock.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /time-clock/history', () => {
  it('with userId — chain manager and HR may, stranger and admin-without-hr may not', async () => {
    for (const caller of [MANAGER, TEAM_LEAD, HR]) {
      const { controller, prisma } = makeClock();
      await controller.getHistory(caller, '30', '2026-11-01', '2026-11-30');
      expect(prisma.timeClock.findMany.mock.calls[0][0].where.userId).toBe(30);
    }
    for (const caller of [STRANGER, ADMIN]) {
      const { controller, prisma } = makeClock();
      const res = await denial(controller.getHistory(caller, '30', '2026-11-01', '2026-11-30'));
      expect(res).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'NOT_IN_MANAGER_CHAIN' } });
      expect(res.message).toContain('You can only view attendance of employees you manage.');
      expect(prisma.timeClock.findMany).not.toHaveBeenCalled();
    }
  });

  it('without userId — only visible users', async () => {
    const { controller, prisma } = makeClock();
    await controller.getHistory(TEAM_LEAD, undefined as any, '', '');
    expect([...prisma.timeClock.findMany.mock.calls[0][0].where.userId.in].sort()).toEqual([21, 30]);

    const hr = makeClock();
    await hr.controller.getHistory(HR, '' as any, '', '');
    expect(hr.prisma.timeClock.findMany.mock.calls[0][0].where.userId).toBeUndefined();
  });

  it('own history is always allowed', async () => {
    const { controller, prisma } = makeClock();
    await controller.getHistory(STRANGER, 40, '', '');
    expect(prisma.timeClock.findMany.mock.calls[0][0].where.userId).toBe(40);
  });
});

describe('PATCH /time-clock/:id/approve', () => {
  it('the chain approves — even with only the Employee preset (no time:approve)', async () => {
    for (const caller of [MANAGER, TEAM_LEAD]) {
      const { controller, prisma } = makeClock();
      await controller.approve(500, caller);
      expect(prisma.timeClock.update).toHaveBeenCalledWith({
        where: { id: 500 },
        data: { approvedBy: caller.id, approvedAt: expect.any(Date) },
      });
    }
  });

  it('hr:approve approves anyone', async () => {
    const { controller, prisma } = makeClock();
    await controller.approve(500, HR);
    expect(prisma.timeClock.update).toHaveBeenCalled();
  });

  it('a stranger with time:approve and an admin without hr are refused', async () => {
    for (const caller of [STRANGER, ADMIN]) {
      const { controller, prisma } = makeClock();
      const res = await denial(controller.approve(500, caller));
      expect(res.details).toEqual({ reason: 'NOT_IN_MANAGER_CHAIN' });
      expect(res.message).toContain('approve attendance of employees you manage');
      expect(prisma.timeClock.update).not.toHaveBeenCalled();
    }
  });

  it('never one’s own record — not the employee, not HR', async () => {
    const own = makeClock({ id: 500, userId: 30 });
    const res = await denial(own.controller.approve(500, EMPLOYEE));
    expect(res.details).toEqual({ reason: 'SELF_APPROVAL' });
    expect(own.prisma.timeClock.update).not.toHaveBeenCalled();

    const hrOwn = makeClock({ id: 501, userId: HR.id });
    await denial(hrOwn.controller.approve(501, HR));
    expect(hrOwn.prisma.timeClock.update).not.toHaveBeenCalled();
  });

  it('a missing record is 404, not a Prisma 500', async () => {
    const { controller, prisma } = makeClock();
    await expect(controller.approve(404, HR)).rejects.toThrow(NotFoundException);
    expect(prisma.timeClock.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /time-clock/:id/edit', () => {
  it('the chain edits (Manager preset, no time:write) and the edit clears the approval', async () => {
    const { controller, prisma } = makeClock({ id: 500, userId: 30, approvedBy: 21, approvedAt: new Date() });
    await controller.edit(500, TEAM_LEAD, { clockOut: '2026-11-22T15:00:00Z', reason: 'forgot to clock out' });
    const data = prisma.timeClock.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'edited',
      editedBy: TEAM_LEAD.id,
      editedReason: 'forgot to clock out',
      approvedBy: null,
      approvedAt: null,
      totalMinutes: 540,
    });
  });

  it('hr:write edits', async () => {
    const { controller, prisma } = makeClock();
    await controller.edit(500, HR, { note: 'x' });
    expect(prisma.timeClock.update.mock.calls[0][0].data).toMatchObject({ approvedBy: null, approvedAt: null, note: 'x' });
  });

  it('stranger / admin-without-hr / own record are refused', async () => {
    for (const caller of [STRANGER, ADMIN]) {
      const { controller, prisma } = makeClock();
      const res = await denial(controller.edit(500, caller, { note: 'x' }));
      expect(res.details).toEqual({ reason: 'NOT_IN_MANAGER_CHAIN' });
      expect(prisma.timeClock.update).not.toHaveBeenCalled();
    }
    const own = makeClock({ id: 500, userId: 30 });
    const res = await denial(own.controller.edit(500, EMPLOYEE, { note: 'x' }));
    expect(res.details).toEqual({ reason: 'SELF_EDIT' });
  });

  it('a missing record is 404', async () => {
    const { controller } = makeClock();
    await expect(controller.edit(404, HR, {})).rejects.toThrow(NotFoundException);
  });
});

describe('POST /time-clock/mark-absent', () => {
  it('chain and HR may; stranger, admin-without-hr and self may not', async () => {
    for (const caller of [MANAGER, HR]) {
      const { controller, prisma } = makeClock();
      await controller.markAbsent(caller, 30, '2026-11-20', 'sick call');
      expect(prisma.timeClock.create).toHaveBeenCalled();
    }
    for (const caller of [STRANGER, ADMIN, EMPLOYEE]) {
      const { controller, prisma } = makeClock();
      await denial(controller.markAbsent(caller, 30, '2026-11-20'));
      expect(prisma.timeClock.create).not.toHaveBeenCalled();
    }
  });
});

describe('clock-in / clock-out activity log — no lateness or overtime', () => {
  it('a late clock-in logs just "Clocked in"', async () => {
    const { service, prisma, activityLog } = makeClock();
    prisma.workSchedule.findFirst.mockResolvedValue({ shiftStart: '00:00', shiftEnd: '00:01', breakMinutes: 0 });
    prisma.timeClock.create.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
    const rec: any = await service.clockIn(30, {} as any);
    expect(rec.isLate).toBe(true); // still recorded on the row
    expect(activityLog.write.mock.calls[0][0].description).toBe('Clocked in');
  });

  it('an overtime clock-out logs just "Clocked out" — no hours, no overtime', async () => {
    const { service, prisma, activityLog } = makeClock();
    prisma.timeClock.findFirst.mockResolvedValue({
      id: 2,
      clockIn: new Date(Date.now() - 10 * 3600_000),
      breakMinutes: 0,
      expectedMinutes: 60,
      note: null,
    });
    prisma.timeClock.update.mockImplementation(async ({ data }: any) => ({ id: 2, ...data }));
    const rec: any = await service.clockOut(30, {} as any);
    expect(rec.overtimeMinutes).toBeGreaterThan(0);
    expect(rec.totalMinutes).toBeGreaterThan(0); // still recorded on the row
    expect(activityLog.write.mock.calls[0][0].description).toBe('Clocked out');
  });
});

// ─── Time entries ──────────────────────────────────────────────────────

function makeEntries(entry: any = null) {
  const org = makeOrgPrisma();
  const scope = new EmployeeScopeService(org as any);
  const svc: any = {
    getDailyBreakdown: jest.fn(async () => ({ date: 'd' })),
    getWeekDailyBreakdown: jest.fn(async () => []),
    getWeeklyGrid: jest.fn(async () => ({ rows: [] })),
    findOne: jest.fn(async () => {
      if (!entry) throw new NotFoundException('Time entry not found');
      return entry;
    }),
  };
  const controller = new TimeEntriesController(svc, {} as any, scope);
  return { controller, svc };
}

describe('GET /time-entries/daily + /weekly — ?userId= of someone else', () => {
  it('self (no userId) reads his own', async () => {
    const { controller, svc } = makeEntries();
    await controller.getDailyBreakdown(STRANGER, undefined, NaN as any, '2026-11-16');
    expect(svc.getWeekDailyBreakdown).toHaveBeenCalledWith(40, '2026-11-16');
    await controller.getWeeklyGrid(STRANGER, '2026-11-16', NaN as any);
    expect(svc.getWeeklyGrid).toHaveBeenCalledWith(40, '2026-11-16', {});
  });

  it('chain manager and HR may read the employee', async () => {
    for (const caller of [MANAGER, TEAM_LEAD, HR]) {
      const { controller, svc } = makeEntries();
      await controller.getDailyBreakdown(caller, '2026-11-16', 30);
      expect(svc.getDailyBreakdown).toHaveBeenCalledWith(30, '2026-11-16');
      await controller.getWeeklyGrid(caller, '2026-11-16', 30);
      expect(svc.getWeeklyGrid).toHaveBeenCalledWith(30, '2026-11-16', {});
    }
  });

  it('stranger, project leader and admin-without-hr get 403 and no data', async () => {
    for (const caller of [STRANGER, LEADER, ADMIN]) {
      const { controller, svc } = makeEntries();
      const res = await denial(controller.getDailyBreakdown(caller, undefined, 30, '2026-11-16'));
      expect(res.code).toBe('PERMISSION_DENIED');
      await denial(controller.getWeeklyGrid(caller, '2026-11-16', 30));
      expect(svc.getWeekDailyBreakdown).not.toHaveBeenCalled();
      expect(svc.getWeeklyGrid).not.toHaveBeenCalled();
    }
  });

  it('the subordinate cannot read his manager', async () => {
    const { controller } = makeEntries();
    await denial(controller.getWeeklyGrid(EMPLOYEE, '2026-11-16', 20));
  });

  it('/daily needs weekStart or date', async () => {
    const { controller } = makeEntries();
    await expect(controller.getDailyBreakdown(EMPLOYEE, undefined, undefined, undefined)).rejects.toThrow(BadRequestException);
  });
});

describe('GET /time-entries/:id', () => {
  const entry = {
    id: 7,
    userId: 30,
    projectId: 59,
    date: new Date('2026-11-16'),
    minutes: 90,
    note: 'clash review',
    location: 'office',
    specialHourBucketId: 4,
    timeClockId: 500,
    startTime: '08:00',
    endTime: '09:30',
    task: { id: 11, name: 'Model L2', projectId: 59 },
  };

  it('owner, HR and the chain get the full entry', async () => {
    for (const caller of [EMPLOYEE, HR, MANAGER, TEAM_LEAD]) {
      const { controller } = makeEntries(entry);
      await expect(controller.findOne(caller, 7)).resolves.toBe(entry);
    }
  });

  it('the project leader gets date / task / hours / note only', async () => {
    const { controller } = makeEntries(entry);
    const out: any = await controller.findOne(LEADER, 7);
    expect(out).toMatchObject({ id: 7, userId: 30, minutes: 90, note: 'clash review', task: { id: 11 } });
    for (const k of ['location', 'specialHourBucketId', 'timeClockId', 'startTime', 'endTime']) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it('the leader rule resolves the project through the task when entry.projectId is NULL', async () => {
    const { controller } = makeEntries({ ...entry, projectId: null });
    const out: any = await controller.findOne(LEADER, 7);
    expect(out).not.toHaveProperty('location');
  });

  it('stranger and admin-without-hr get 403', async () => {
    for (const caller of [STRANGER, ADMIN]) {
      const { controller } = makeEntries(entry);
      const res = await denial(controller.findOne(caller, 7));
      expect(res.message).toContain('You can only view time entries of employees you manage.');
    }
  });

  it('a leader of ANOTHER project gets 403', async () => {
    const { controller } = makeEntries({ ...entry, projectId: 60, task: { ...entry.task, projectId: 60 } });
    await denial(controller.findOne(LEADER, 7));
  });
});

describe('TimeEntriesService — soft-deleted entries and the week breakdown', () => {
  function makeService(over: any = {}) {
    const prisma: any = {
      timeEntry: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      timeClock: { findMany: jest.fn(async () => []) },
      workSchedule: { findMany: jest.fn(async () => []) },
      calendarDay: { findMany: jest.fn(async () => []) },
      ...over,
    };
    return { prisma, service: new TimeEntriesService(prisma, { write: jest.fn() } as any) };
  }

  it('findOne ignores soft-deleted entries', async () => {
    const { prisma, service } = makeService();
    await expect(service.findOne(7)).rejects.toThrow(NotFoundException);
    expect(prisma.timeEntry.findFirst.mock.calls[0][0].where).toEqual({ id: 7, deletedAt: null });
  });

  it('getDailyBreakdown filters deletedAt', async () => {
    const { prisma, service } = makeService();
    await service.getDailyBreakdown(30, '2026-11-16');
    expect(prisma.timeEntry.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it('getWeekDailyBreakdown returns the 7-day DailyBreakdown[] the web renders', async () => {
    const mon = new Date(2026, 10, 16);
    const { prisma, service } = makeService({
      timeEntry: {
        findMany: jest.fn(async () => [
          { id: 1, date: mon, minutes: 300, project: null, task: null },
          { id: 2, date: mon, minutes: 170, project: null, task: null },
        ]),
      },
      timeClock: { findMany: jest.fn(async () => [{ id: 9, date: mon, totalMinutes: 480, clockIn: mon }]) },
      workSchedule: {
        findMany: jest.fn(async () => [
          { dayOfWeek: 1, shiftStart: '08:00', shiftEnd: '17:00', breakMinutes: 30, effectiveFrom: new Date(2020, 0, 1), effectiveUntil: null },
        ]),
      },
    });
    const days = await service.getWeekDailyBreakdown(30, '2026-11-16');
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({
      date: '2026-11-16',
      clock: { id: 9 },
      expected: { shiftStart: '08:00', shiftEnd: '17:00', breakMinutes: 30, expectedMinutes: 510 },
      totalLogged: 470,
      difference: -10,
      isBalanced: true,
    });
    expect(days[0].entries).toHaveLength(2);
    expect(days[1]).toMatchObject({ date: '2026-11-17', clock: null, expected: null, totalLogged: 0, difference: null, isBalanced: false });
    expect(prisma.timeEntry.findMany.mock.calls[0][0].where).toMatchObject({ userId: 30, deletedAt: null });
  });

  it('getWeekDailyBreakdown rejects a bad weekStart', async () => {
    const { service } = makeService();
    await expect(service.getWeekDailyBreakdown(30, 'nope')).rejects.toThrow(BadRequestException);
  });
});
