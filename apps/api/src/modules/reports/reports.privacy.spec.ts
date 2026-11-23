/**
 * Permissions round 3 — privacy (2026-11-22): per-person reports.
 *
 *   • Every per-person report shows only the employees the caller may
 *     see (everyone for hr:read; otherwise himself + the people he
 *     manages — an Admin without hr included).
 *   • Time-entry reports (detailed / by-project / by-label / activity
 *     and their exports) also show entries on projects the caller
 *     LEADS — date, task, hours, note; no time-of-day window,
 *     location, special-hours bucket or seniority.
 *   • A userId filter for someone not visible → 403 (attendance), or —
 *     on time-entry reports — that person's entries on the caller's
 *     projects when he leads any.
 *   • Soft-deleted entries never count.
 */
import { ForbiddenException } from '@nestjs/common';

import { ReportsController } from './reports.controller';
import { ReportsService, exportScopeKind, timeEntryScopeWhere } from './reports.service';
import { ALL_TIME_SCOPE, NO_TIME_SCOPE, TimeEntryScope } from '../../common/services/employee-scope.service';

const MANAGER_SCOPE: TimeEntryScope = { visibleUserIds: [20, 30], ledProjectIds: [] };
const LEADER_SCOPE: TimeEntryScope = { visibleUserIds: [50], ledProjectIds: [59] };

const USER = { id: 50, isAdmin: false, roleModules: [{ module: { route: '/reports' }, canRead: true, canExport: true }] };

function detailedEntry(id: number, userId: number) {
  return {
    id,
    date: new Date('2026-11-02T00:00:00Z'),
    startTime: '08:00',
    endTime: '12:00',
    minutes: 240,
    note: `note ${id}`,
    user: { id: userId, firstName: `U${userId}`, lastName: 'X' },
    task: {
      id: 11,
      name: 'Model L2',
      projectId: 59,
      project: { id: 59, name: 'Tower A', number: '1001' },
      zone: null,
      deliverableTemplate: null,
      phase: null,
    },
  };
}

function fullEntry(id: number, userId: number) {
  return {
    id,
    userId,
    projectId: 59,
    date: new Date('2026-11-02T00:00:00Z'),
    minutes: 120,
    note: 'n',
    isBillable: true,
    location: 'home',
    specialHourBucketId: 3,
    timeClockId: 900,
    startTime: '08:00',
    endTime: '10:00',
    project: { id: 59, name: 'Tower A' },
    user: { id: userId, firstName: 'A', lastName: 'B' },
    task: { id: 11, name: 'Model L2', zone: { id: 4, name: 'L2', path: '/4/' } },
  };
}

function makePrisma(entries: any[] = [], clocks: any[] = []) {
  return {
    timeEntry: { findMany: jest.fn(async () => entries) },
    timeClock: { findMany: jest.fn(async () => clocks) },
    zone: { findMany: jest.fn(async () => []) },
    userSeniority: {
      findMany: jest.fn(async () => [
        { userId: 30, startDate: new Date('2020-01-01'), endDate: null, seniorityLevel: { name: 'Senior', defaultHourlyCost: '100', currency: 'ILS' } },
        { userId: 77, startDate: new Date('2020-01-01'), endDate: null, seniorityLevel: { name: 'Junior', defaultHourlyCost: '50', currency: 'ILS' } },
      ]),
    },
  } as any;
}

const whereOf = (mock: jest.Mock, i = 0) => mock.mock.calls[i][0].where;

describe('timeEntryScopeWhere', () => {
  it("'all' → no restriction", () => {
    expect(timeEntryScopeWhere(ALL_TIME_SCOPE)).toBeNull();
  });
  it('nobody → matches nothing', () => {
    expect(timeEntryScopeWhere(NO_TIME_SCOPE)).toEqual({ userId: { in: [] } });
  });
  it('visible users OR led projects (through the entry and through its task)', () => {
    expect(timeEntryScopeWhere({ visibleUserIds: [50], ledProjectIds: [59] })).toEqual({
      OR: [{ userId: { in: [50] } }, { projectId: { in: [59] } }, { task: { projectId: { in: [59] } } }],
    });
  });
});

describe('ReportsService — time-entry reports', () => {
  it('timesheetDetailed: scope in the where; leader-only rows lose time window + seniority', async () => {
    const prisma = makePrisma([detailedEntry(1, 50), detailedEntry(2, 77)]);
    const out = await new ReportsService(prisma).timesheetDetailed({} as any, LEADER_SCOPE);
    const where = whereOf(prisma.timeEntry.findMany);
    expect(where.deletedAt).toBeNull();
    expect(where.AND).toEqual([timeEntryScopeWhere(LEADER_SCOPE)]);

    const own = out.rows.find((r: any) => r.id === 1)!;
    const led = out.rows.find((r: any) => r.id === 2)!;
    expect(own).toMatchObject({ startTime: '08:00', endTime: '12:00' });
    expect(led).toMatchObject({ date: '2026-11-02', hours: 4, assignmentName: 'Model L2', description: 'note 2', startTime: null, endTime: null, seniorityLevelName: null });
  });

  it('timesheetDetailed keeps the project / personal filters next to the scope', async () => {
    const prisma = makePrisma([]);
    await new ReportsService(prisma).timesheetDetailed({ projectId: 59, personal: 'exclude', userId: 30 } as any, MANAGER_SCOPE);
    expect(whereOf(prisma.timeEntry.findMany)).toMatchObject({
      userId: 30,
      task: { projectId: 59, isPersonal: false },
      AND: [{ OR: [{ userId: { in: [20, 30] } }] }],
    });
  });

  it('timesheetByProject / by-label / activity: leader-only entries in the leader view, visible ones intact', async () => {
    for (const method of ['timesheetByProject', 'timesheetByLabel', 'timesheetActivity'] as const) {
      const prisma = makePrisma([fullEntry(1, 50), fullEntry(2, 77)]);
      const out: any = await (new ReportsService(prisma) as any)[method]({} as any, LEADER_SCOPE);
      const where = whereOf(prisma.timeEntry.findMany);
      expect(where.deletedAt).toBeNull();
      expect(where.AND).toEqual([timeEntryScopeWhere(LEADER_SCOPE)]);
      const rows: any[] = method === 'timesheetActivity' ? out : out.flatMap((g: any) => g.entries);
      const own = rows.find((e) => e.id === 1);
      const led = rows.find((e) => e.id === 2);
      expect(own).toMatchObject({ location: 'home', specialHourBucketId: 3, timeClockId: 900, startTime: '08:00' });
      expect(led).toMatchObject({ minutes: 120, note: 'n', task: { id: 11 } });
      for (const k of ['location', 'specialHourBucketId', 'timeClockId', 'startTime', 'endTime']) {
        expect(led).not.toHaveProperty(k);
      }
    }
  });

  it('without a scope the service shows nobody (fail closed)', async () => {
    const prisma = makePrisma([]);
    await new ReportsService(prisma).timesheetByProject({} as any);
    expect(whereOf(prisma.timeEntry.findMany).AND).toEqual([{ userId: { in: [] } }]);
  });

  it("hr:read ('all') — no user restriction", async () => {
    const prisma = makePrisma([]);
    await new ReportsService(prisma).timesheetByProject({} as any, ALL_TIME_SCOPE);
    expect(whereOf(prisma.timeEntry.findMany).AND).toBeUndefined();
  });

  it('cost reports are unscoped finance aggregates but skip soft-deleted entries', async () => {
    for (const method of ['costByTask', 'costByLabel', 'costByProject'] as const) {
      const prisma = makePrisma([]);
      await (new ReportsService(prisma) as any)[method]({} as any);
      const where = whereOf(prisma.timeEntry.findMany);
      expect(where.deletedAt).toBeNull();
      expect(where.AND).toBeUndefined();
      expect(where.userId).toBeUndefined();
    }
  });
});

describe('ReportsService — attendance reports (visible users only)', () => {
  it('attendance / overtime / late arrivals filter on the visible ids', async () => {
    for (const method of ['attendanceSummary', 'overtimeReport', 'lateArrivalsReport'] as const) {
      const prisma = makePrisma([], []);
      await (new ReportsService(prisma) as any)[method]({} as any, [20, 30]);
      expect(whereOf(prisma.timeClock.findMany).AND).toEqual([{ userId: { in: [20, 30] } }]);
    }
  });

  it('nobody by default; no restriction for all', async () => {
    const none = makePrisma();
    await new ReportsService(none).overtimeReport({} as any);
    expect(whereOf(none.timeClock.findMany).AND).toEqual([{ userId: { in: [] } }]);
    const all = makePrisma();
    await new ReportsService(all).overtimeReport({} as any, 'all');
    expect(whereOf(all.timeClock.findMany).AND).toBeUndefined();
  });

  it('timesheetToday: clock records and logged totals of visible users only', async () => {
    const prisma = makePrisma([], []);
    await new ReportsService(prisma).timesheetToday([20, 30]);
    expect(whereOf(prisma.timeClock.findMany).userId).toEqual({ in: [20, 30] });
    expect(whereOf(prisma.timeEntry.findMany)).toMatchObject({ userId: { in: [20, 30] }, deletedAt: null });
  });

  it('attendanceSummary counts distinct days; sick and leave are not "present"', async () => {
    const d1 = new Date('2026-11-02T00:00:00Z');
    const d2 = new Date('2026-11-03T00:00:00Z');
    const d3 = new Date('2026-11-04T00:00:00Z');
    const user = { id: 30, firstName: 'Dana', lastName: 'L' };
    const clocks = [
      { userId: 30, user, date: d1, status: 'completed', isLate: true, totalMinutes: 240, overtimeMinutes: 0 },
      { userId: 30, user, date: d1, status: 'completed', isLate: false, totalMinutes: 200, overtimeMinutes: 0 },
      { userId: 30, user, date: d2, status: 'sick', isLate: false, totalMinutes: 0, overtimeMinutes: 0 },
      { userId: 30, user, date: d3, status: 'leave', isLate: false, totalMinutes: 0, overtimeMinutes: 0 },
    ];
    const out: any[] = await new ReportsService(makePrisma([], clocks)).attendanceSummary({} as any, 'all');
    expect(out).toEqual([
      expect.objectContaining({ user, totalDays: 3, presentDays: 1, sickDays: 1, leaveDays: 1, absentDays: 0, lateDays: 1, totalMinutes: 440 }),
    ]);
  });
});

describe('ReportsController — scope + userId filter', () => {
  function make(scope: TimeEntryScope) {
    const reportsService: any = {
      timesheetDetailed: jest.fn(async () => ({ rows: [], totals: { totalHours: 0, rowCount: 0, byCurrency: [] } })),
      timesheetByProject: jest.fn(async () => []),
      timesheetByLabel: jest.fn(async () => []),
      timesheetActivity: jest.fn(async () => []),
      timesheetToday: jest.fn(async () => ({})),
      attendanceSummary: jest.fn(async () => []),
      overtimeReport: jest.fn(async () => []),
      lateArrivalsReport: jest.fn(async () => []),
      exportReport: jest.fn(async () => Buffer.from('x')),
    };
    const employeeScope: any = {
      timeEntryScope: jest.fn(async () => scope),
      visibleUserIds: jest.fn(async () => scope.visibleUserIds),
    };
    return { ctrl: new ReportsController(reportsService, employeeScope, {} as any), reportsService, employeeScope };
  }
  const res = () => ({ set: jest.fn(), send: jest.fn() }) as any;

  it('passes the caller’s scope to every per-person route', async () => {
    const { ctrl, reportsService } = make(MANAGER_SCOPE);
    await ctrl.timesheetDetailed(USER, {} as any);
    expect(reportsService.timesheetDetailed).toHaveBeenCalledWith({}, MANAGER_SCOPE);
    await ctrl.timesheetByProject(USER, {} as any);
    expect(reportsService.timesheetByProject).toHaveBeenCalledWith({}, MANAGER_SCOPE);
    await ctrl.timesheetByLabel(USER, {} as any);
    expect(reportsService.timesheetByLabel).toHaveBeenCalledWith({}, MANAGER_SCOPE);
    await ctrl.timesheetActivity(USER, {} as any);
    expect(reportsService.timesheetActivity).toHaveBeenCalledWith({}, MANAGER_SCOPE);
    await ctrl.timesheetToday(USER);
    expect(reportsService.timesheetToday).toHaveBeenCalledWith([20, 30]);
    await ctrl.attendanceSummary(USER, {} as any);
    expect(reportsService.attendanceSummary).toHaveBeenCalledWith({}, [20, 30]);
    await ctrl.overtime(USER, {} as any);
    expect(reportsService.overtimeReport).toHaveBeenCalledWith({}, [20, 30]);
    await ctrl.lateArrivals(USER, {} as any);
    expect(reportsService.lateArrivalsReport).toHaveBeenCalledWith({}, [20, 30]);
  });

  it('userId of a visible employee is fine', async () => {
    const { ctrl, reportsService } = make(MANAGER_SCOPE);
    await ctrl.overtime(USER, { userId: 30 } as any);
    await ctrl.timesheetDetailed(USER, { userId: 30 } as any);
    expect(reportsService.overtimeReport).toHaveBeenCalled();
    expect(reportsService.timesheetDetailed).toHaveBeenCalled();
  });

  it('userId of someone not visible → 403 on attendance and on time entries (no led projects)', async () => {
    const { ctrl, reportsService } = make(MANAGER_SCOPE);
    for (const call of [
      () => ctrl.attendanceSummary(USER, { userId: 77 } as any),
      () => ctrl.overtime(USER, { userId: 77 } as any),
      () => ctrl.lateArrivals(USER, { userId: 77 } as any),
      () => ctrl.timesheetDetailed(USER, { userId: 77 } as any),
      () => ctrl.timesheetByProject(USER, { userId: 77 } as any),
      () => ctrl.timesheetActivity(USER, { userId: 77 } as any),
    ]) {
      const err: any = await call().catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'NOT_IN_MANAGER_CHAIN' } });
    }
    expect(reportsService.attendanceSummary).not.toHaveBeenCalled();
    expect(reportsService.timesheetDetailed).not.toHaveBeenCalled();
  });

  it('a project leader filtering on a team member gets the time-entry report (led projects only), not attendance', async () => {
    const { ctrl, reportsService } = make(LEADER_SCOPE);
    await ctrl.timesheetDetailed(USER, { userId: 77 } as any);
    expect(reportsService.timesheetDetailed).toHaveBeenCalledWith({ userId: 77 }, LEADER_SCOPE);
    await expect(ctrl.overtime(USER, { userId: 77 } as any)).rejects.toThrow(ForbiddenException);
  });

  it("hr:read ('all') may filter on anyone", async () => {
    const { ctrl, reportsService } = make(ALL_TIME_SCOPE);
    await ctrl.attendanceSummary(USER, { userId: 77 } as any);
    expect(reportsService.attendanceSummary).toHaveBeenCalledWith({ userId: 77 }, 'all');
  });

  it('exports: attendance types → visible ids only; entry types → full scope; cost-by-project → unscoped', async () => {
    const { ctrl, reportsService, employeeScope } = make(LEADER_SCOPE);
    await ctrl.exportReport(USER, 'overtime', 'excel', {} as any, res());
    expect(reportsService.exportReport).toHaveBeenLastCalledWith('overtime', 'excel', {}, {
      canSeeFinance: false,
      scope: { visibleUserIds: [50], ledProjectIds: [] },
    });
    await ctrl.exportReport(USER, 'timesheet-by-project', 'excel', {} as any, res());
    expect(reportsService.exportReport).toHaveBeenLastCalledWith('timesheet-by-project', 'excel', {}, {
      canSeeFinance: false,
      scope: LEADER_SCOPE,
    });
    await expect(ctrl.exportReport(USER, 'attendance', 'excel', { userId: 77 } as any, res())).rejects.toThrow(ForbiddenException);

    const financeUser = { ...USER, roleModules: [...USER.roleModules, { module: { route: '/finance' }, canRead: true }] };
    employeeScope.timeEntryScope.mockClear();
    employeeScope.visibleUserIds.mockClear();
    await ctrl.exportReport(financeUser, 'cost-by-project', 'excel', {} as any, res());
    expect(reportsService.exportReport).toHaveBeenLastCalledWith('cost-by-project', 'excel', {}, { canSeeFinance: true });
    expect(employeeScope.timeEntryScope).not.toHaveBeenCalled();
    expect(employeeScope.visibleUserIds).not.toHaveBeenCalled();
  });

  it('exportScopeKind', () => {
    expect(exportScopeKind('attendance')).toBe('attendance');
    expect(exportScopeKind('overtime')).toBe('attendance');
    expect(exportScopeKind('late-arrivals')).toBe('attendance');
    expect(exportScopeKind('cost-by-project')).toBe('none');
    expect(exportScopeKind('timesheet-detailed')).toBe('entries');
    expect(exportScopeKind('timesheet-by-project')).toBe('entries');
    // falls through to timesheetByProject in the service → scoped
    expect(exportScopeKind('cost-by-task')).toBe('entries');
    expect(exportScopeKind(undefined)).toBe('entries');
  });

  it('service exports apply the scope (attendance rows of visible users only)', async () => {
    const prisma = makePrisma([], []);
    await new ReportsService(prisma).exportReport('late-arrivals', 'excel', {} as any, {
      canSeeFinance: false,
      scope: MANAGER_SCOPE,
    });
    expect(whereOf(prisma.timeClock.findMany).AND).toEqual([{ userId: { in: [20, 30] } }]);
  });
});
