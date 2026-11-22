/**
 * Permissions round 3 — privacy (2026-11-22): per-person logged hours
 * outside the timesheet screens.
 *
 *   • GET /workload/user/:userId — self or canViewEmployee (hr:read /
 *     manager chain). Admin is no longer an exception.
 *   • GET /projects/:id/workload — actual (logged) hours only for
 *     members the caller may see; others get null.
 *   • GET /dashboard/operations — weekly logged hours only for visible
 *     users; others are listed with `hoursWeek: null` and left out of
 *     overloaded / available / employees at risk / dept hour totals.
 */
import { ForbiddenException } from '@nestjs/common';

import { ExecutionPlanningController } from './execution-planning.controller';
import { ExecutionPlanningService } from './execution-planning.service';

describe('GET /workload/user/:userId', () => {
  function make(canView: boolean) {
    const eps: any = { getUserWorkload: jest.fn(async () => ({ dailyData: [], summary: {} })) };
    const scope: any = { canViewEmployee: jest.fn(async () => canView) };
    return { ctrl: new ExecutionPlanningController(eps, {} as any, scope), eps, scope };
  }

  it('own workload — no scope check', async () => {
    const { ctrl, eps, scope } = make(false);
    await ctrl.getUserWorkload({ id: 7, isAdmin: false }, 7, '2026-11-16', '2026-11-20');
    expect(eps.getUserWorkload).toHaveBeenCalledWith(7, '2026-11-16', '2026-11-20');
    expect(scope.canViewEmployee).not.toHaveBeenCalled();
  });

  it('someone the caller may view (HR / manager chain)', async () => {
    const { ctrl, eps } = make(true);
    await ctrl.getUserWorkload({ id: 7, isAdmin: false }, 30, 'a', 'b');
    expect(eps.getUserWorkload).toHaveBeenCalledWith(30, 'a', 'b');
  });

  it('an admin without hr / a stranger → 403', async () => {
    for (const user of [{ id: 1, isAdmin: true, roleModules: [] }, { id: 7, isAdmin: false }]) {
      const { ctrl, eps } = make(false);
      const err: any = await ctrl.getUserWorkload(user, 30, 'a', 'b').catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'NOT_IN_MANAGER_CHAIN' } });
      expect(eps.getUserWorkload).not.toHaveBeenCalled();
    }
  });
});

describe('GET /projects/:id/workload — actual hours of visible members only', () => {
  function makeService() {
    const prisma: any = {
      projectMember: {
        findMany: jest.fn(async () => [
          { userId: 20, role: 'lead', user: { id: 20, firstName: 'M', lastName: 'G' } },
          { userId: 77, role: 'member', user: { id: 77, firstName: 'O', lastName: 'T' } },
        ]),
      },
    };
    const svc = new ExecutionPlanningService(prisma, {} as any);
    jest.spyOn(svc, 'getUserWorkload').mockImplementation(async () => ({
      dailyData: [{ date: '2026-11-16', dayOfWeek: 1, capacityHours: 8, plannedHours: 6, actualHours: 5, utilizationPct: 75, isHoliday: false, tasks: [] }],
      summary: { totalPlanned: 6, totalCapacity: 8, totalActual: 5, overloadedDays: 0, avgUtilization: 75 },
    }));
    return svc;
  }

  it('keeps planned/capacity for everyone, nulls actuals of members the caller can’t see', async () => {
    const out: any = await makeService().getProjectWorkload(59, '2026-11-16', '2026-11-20', [20]);
    const seen = out.members.find((m: any) => m.user.id === 20).workload;
    const hidden = out.members.find((m: any) => m.user.id === 77).workload;
    expect(seen.summary.totalActual).toBe(5);
    expect(seen.dailyData[0].actualHours).toBe(5);
    expect(hidden.summary).toMatchObject({ totalActual: null, totalPlanned: 6, totalCapacity: 8 });
    expect(hidden.dailyData[0]).toMatchObject({ actualHours: null, plannedHours: 6, capacityHours: 8 });
  });

  it("'all' (hr:read) keeps every actual; no scope = nobody's", async () => {
    const all: any = await makeService().getProjectWorkload(59, 'a', 'b', 'all');
    expect(all.members.every((m: any) => m.workload.summary.totalActual === 5)).toBe(true);
    const none: any = await makeService().getProjectWorkload(59, 'a', 'b');
    expect(none.members.every((m: any) => m.workload.summary.totalActual === null)).toBe(true);
  });

  it('the controller passes the caller’s visible ids', async () => {
    const eps: any = { getProjectWorkload: jest.fn(async () => ({})) };
    const access: any = { assertProjectAccess: jest.fn(async () => undefined) };
    const scope: any = { visibleUserIds: jest.fn(async () => [7, 30]) };
    const ctrl = new ExecutionPlanningController(eps, access, scope);
    await ctrl.getProjectWorkload({ id: 7, isAdmin: false }, 59, 'a', 'b');
    expect(eps.getProjectWorkload).toHaveBeenCalledWith(59, 'a', 'b', [7, 30]);
  });
});

describe('GET /dashboard/operations — weekly hours of visible users only', () => {
  function makeService() {
    const employees = [
      { id: 20, firstName: 'M', lastName: 'G', avatarUrl: null, position: 'PM', orgUnitId: 5, orgUnit: { id: 5, name: 'BIM' }, dailyStandardHours: 8 },
      { id: 30, firstName: 'D', lastName: 'L', avatarUrl: null, position: 'Modeler', orgUnitId: 5, orgUnit: { id: 5, name: 'BIM' }, dailyStandardHours: 8 },
      { id: 77, firstName: 'O', lastName: 'T', avatarUrl: null, position: 'Modeler', orgUnitId: 5, orgUnit: { id: 5, name: 'BIM' }, dailyStandardHours: 8 },
    ];
    const overdueTask = {
      id: 1, code: 'T-1', name: 'T1', projectId: 59, endDate: new Date('2020-01-01'), budgetHours: 4, priority: 'high',
      status: 'in_progress', project: { id: 59, name: 'P', number: '1' }, zone: null, serviceType: null, dependencies: [],
      assignees: [{ userId: 30, user: { id: 30 } }, { userId: 77, user: { id: 77 } }],
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ orgUnitId: null, orgUnit: null })), findMany: jest.fn(async () => employees) },
      project: { findMany: jest.fn(async () => [{ id: 59, name: 'P', number: '1', budget: 0, endDate: null, leader: null, department: null }]) },
      task: {
        findMany: jest.fn().mockResolvedValueOnce([overdueTask]).mockResolvedValueOnce([]),
        aggregate: jest.fn(async () => ({ _sum: { budgetAmount: 0, budgetHours: 0 }, _count: 0 })),
      },
      timeEntry: {
        aggregate: jest.fn(async () => ({ _sum: { minutes: 0 } })),
        // 30 and 77 both logged 50h (> 40h capacity) — groupBy is
        // filtered to the visible ids, so return only those asked for.
        groupBy: jest.fn(async ({ where }: any) =>
          [{ userId: 30, _sum: { minutes: 3000 } }, { userId: 77, _sum: { minutes: 3000 } }].filter(
            (r) => !where.userId || where.userId.in.includes(r.userId),
          ),
        ),
      },
      taskAssignee: { groupBy: jest.fn(async () => []) },
    };
    const access: any = { getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })) };
    return { svc: new ExecutionPlanningService(prisma, access), prisma };
  }

  it('a manager sees his people’s hours; the others are listed with null hours and no hour-derived signals', async () => {
    const { svc, prisma } = makeService();
    const out: any = await svc.getOperationsDashboard({ id: 20, isAdmin: false, visibleUserIds: [20, 30] });
    expect(prisma.timeEntry.groupBy.mock.calls[0][0].where.userId).toEqual({ in: [20, 30] });

    const members = out.departments[0].members;
    expect(members.find((m: any) => m.id === 30).hoursWeek).toBe(50);
    expect(members.find((m: any) => m.id === 20).hoursWeek).toBe(0);
    expect(members.find((m: any) => m.id === 77).hoursWeek).toBeNull();
    // dept totals cover the visible members only (capacity included)
    expect(out.departments[0]).toMatchObject({ totalHours: 50, totalCapacity: 80 });
    // 77 is overloaded too, but the caller may not see that
    expect(out.employeesAtRisk.map((e: any) => e.id)).toEqual([30]);
    expect(out.summary).toMatchObject({ overloadedCount: 1, availableCount: 1, availableHours: 40, employeesAtRiskCount: 1 });
  });

  it("hr:read ('all') sees everyone's hours", async () => {
    const { svc, prisma } = makeService();
    const out: any = await svc.getOperationsDashboard({ id: 10, isAdmin: false, visibleUserIds: 'all' });
    expect(prisma.timeEntry.groupBy.mock.calls[0][0].where.userId).toBeUndefined();
    expect(out.departments[0].members.find((m: any) => m.id === 77).hoursWeek).toBe(50);
    expect(out.employeesAtRisk.map((e: any) => e.id).sort()).toEqual([30, 77]);
  });

  it('a caller that does not say sees only his own hours (fail closed)', async () => {
    const { svc } = makeService();
    const out: any = await svc.getOperationsDashboard({ id: 20, isAdmin: true });
    const members = out.departments[0].members;
    expect(members.find((m: any) => m.id === 30).hoursWeek).toBeNull();
    expect(members.find((m: any) => m.id === 20).hoursWeek).toBe(0);
    expect(out.employeesAtRisk).toEqual([]);
  });

  it('a department with no visible member has totalHours null', async () => {
    const { svc } = makeService();
    const out: any = await svc.getOperationsDashboard({ id: 99, isAdmin: false, visibleUserIds: [99] });
    expect(out.departments[0]).toMatchObject({ totalHours: null, totalCapacity: 120 });
  });
});
