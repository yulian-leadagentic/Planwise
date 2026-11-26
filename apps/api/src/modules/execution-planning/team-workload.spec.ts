/**
 * QA6 P3 (PR-073) — GET /workload/team: one call, every active employee
 * (no 30 cap), the org work week with Sunday, planned for everyone,
 * logged only inside the caller's round-3 scope, task names of projects
 * the caller cannot open masked.
 */
import { BadRequestException } from '@nestjs/common';

import { ExecutionPlanningController } from './execution-planning.controller';
import { ExecutionPlanningService, subtreeUnitIds } from './execution-planning.service';

const WEEK_FROM = '2026-11-22'; // Sunday
const WEEK_TO = '2026-11-28';

function employees(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    firstName: `F${String(i + 1).padStart(2, '0')}`,
    lastName: 'L',
    position: 'Modeler',
    avatarUrl: null,
    dailyStandardHours: 8,
    orgUnitId: i % 2 === 0 ? 5 : 6,
    orgUnit: i % 2 === 0 ? { id: 5, name: 'BIM' } : { id: 6, name: 'MEP' },
  }));
}

function makeService(opts: { people?: number; accessible?: { all: boolean; projectIds: number[] } } = {}) {
  const people = employees(opts.people ?? 45);
  const at = (d: string) => new Date(`${d}T00:00:00Z`);
  const prisma: any = {
    hrSettings: { findFirst: jest.fn(async () => ({ weeklyRestDays: [5, 6] })) },
    calendarDay: { findMany: jest.fn(async () => []) },
    orgUnit: {
      findMany: jest.fn(async () => [
        { id: 5, name: 'BIM', parentId: null, path: '/5/', depth: 0, sortOrder: 0 },
        { id: 6, name: 'MEP', parentId: null, path: '/6/', depth: 0, sortOrder: 1 },
        { id: 7, name: 'BIM North', parentId: 5, path: '/5/7/', depth: 1, sortOrder: 0 },
      ]),
    },
    user: {
      findUnique: jest.fn(async () => ({ orgUnitId: 5 })),
      findMany: jest.fn(async () => people),
    },
    workSchedule: { findMany: jest.fn(async () => []) },
    absenceRecord: { findMany: jest.fn(async () => []) },
    taskAssignee: {
      // Person 1: one task on project 59 (accessible), one on project 60 (not).
      findMany: jest.fn(async () => [
        { userId: 1, task: { id: 11, code: 'OK-1', name: 'Visible task', budgetHours: 10, estimatedStartDate: at(WEEK_FROM), startDate: null, endDate: at('2026-11-26'), projectId: 59, project: { name: 'Open project' } } },
        { userId: 1, task: { id: 12, code: 'SEC-1', name: 'Secret task', budgetHours: 5, estimatedStartDate: at(WEEK_FROM), startDate: null, endDate: at('2026-11-26'), projectId: 60, project: { name: 'Secret project' } } },
        { userId: 2, task: { id: 13, code: 'U-1', name: 'Undated', budgetHours: 7, estimatedStartDate: null, startDate: null, endDate: null, projectId: 59, project: { name: 'Open project' } } },
      ]),
      groupBy: jest.fn(async () => [{ taskId: 11, _count: { _all: 1 } }, { taskId: 12, _count: { _all: 1 } }, { taskId: 13, _count: { _all: 1 } }]),
    },
    timeEntry: {
      groupBy: jest.fn(async ({ by, where }: any) => {
        if (by[0] === 'taskId') return [];
        // Everyone logged 6h on Sunday — filtered to the ids asked for.
        return people
          .filter((p) => where.userId.in.includes(p.id))
          .map((p) => ({ userId: p.id, date: at(WEEK_FROM), _sum: { minutes: 360 } }));
      }),
    },
    // QA6 PR-063 — the drag-and-drop `tasks` index / `assign` block.
    phase: { findMany: jest.fn(async () => []) },
    taskReassignment: { findMany: jest.fn(async () => []) },
    project: { findMany: jest.fn(async () => []) },
    projectMember: { findMany: jest.fn(async () => []) },
    projectPartnerRole: { findMany: jest.fn(async () => []) },
  };
  const access: any = {
    getAccessibleProjectIds: jest.fn(async () => opts.accessible ?? { all: false, projectIds: [59] }),
  };
  return { svc: new ExecutionPlanningService(prisma, access), prisma, access };
}

describe('GET /workload/team', () => {
  it('one call returns every active employee — more than 30 — with a fixed number of queries', async () => {
    const { svc, prisma } = makeService({ people: 45 });
    const out: any = await svc.getTeamWorkload({ id: 1, isAdmin: false, visibleUserIds: [1] }, { from: WEEK_FROM, to: WEEK_TO });
    expect(out.people).toHaveLength(45);
    expect(out.totals.people).toBe(45);
    // batched: one query per table, whatever the head count
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.taskAssignee.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.workSchedule.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.absenceRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ isActive: true, deletedAt: null, userType: { in: ['employee', 'both'] } });
  });

  it('the days are the org work week: Sunday to Thursday, Sunday first', async () => {
    const { svc } = makeService({ people: 3 });
    const out: any = await svc.getTeamWorkload({ id: 1, isAdmin: false }, {});
    expect(new Date(`${out.range.from}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(out.workWeek).toEqual({ restDays: [5, 6], weekStartsOn: 0 });
    const w = await svc.getTeamWorkload({ id: 1, isAdmin: false }, { weekOf: '2026-11-25' });
    expect(w.range).toMatchObject({ from: WEEK_FROM, to: WEEK_TO });
    expect(w.days.map((d: any) => d.date)).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
    expect(w.days[0]).toMatchObject({ dayOfWeek: 0, isWorkingDay: true });
    const p1 = w.people.find((p: any) => p.id === 1)!;
    expect(p1.days).toHaveLength(5);
    expect(p1.days[0].capacity).toBe(8);
    expect(p1.totals.capacity).toBe(40);
  });

  it('LOGGED hours only for people in the caller’s scope; planned for everyone', async () => {
    const { svc, prisma } = makeService({ people: 4 });
    const out: any = await svc.getTeamWorkload({ id: 1, isAdmin: false, visibleUserIds: [1, 2] }, { from: WEEK_FROM, to: WEEK_TO });
    const loggedQuery = prisma.timeEntry.groupBy.mock.calls.find((c: any[]) => c[0].by[0] === 'userId')[0];
    expect(loggedQuery.where.userId).toEqual({ in: [1, 2] });
    const p = (id: number) => out.people.find((x: any) => x.id === id);
    expect(p(2)).toMatchObject({ loggedVisible: true, totals: expect.objectContaining({ logged: 6 }) });
    expect(p(2).days[0].logged).toBe(6);
    expect(p(3)).toMatchObject({ loggedVisible: false, totals: expect.objectContaining({ logged: null }) });
    expect(p(3).days.every((d: any) => d.logged === null)).toBe(true);
    // planned is not private
    expect(p(1).totals.planned).toBe(15);
    expect(out.totals.logged).toBe(12);
  });

  it("hr:read ('all') sees everyone's logged hours; no scope given = only his own", async () => {
    const all: any = await makeService({ people: 4 }).svc.getTeamWorkload({ id: 1, isAdmin: false, visibleUserIds: 'all' }, { from: WEEK_FROM, to: WEEK_TO });
    expect(all.people.every((p: any) => p.totals.logged === 6)).toBe(true);
    const self: any = await makeService({ people: 4 }).svc.getTeamWorkload({ id: 3, isAdmin: false }, { from: WEEK_FROM, to: WEEK_TO });
    expect(self.people.filter((p: any) => p.loggedVisible).map((p: any) => p.id)).toEqual([3]);
  });

  it('task chips of projects the caller cannot open are masked (hours kept)', async () => {
    const { svc } = makeService({ people: 2 });
    const out: any = await svc.getTeamWorkload({ id: 2, isAdmin: false, visibleUserIds: [2] }, { from: WEEK_FROM, to: WEEK_TO });
    const sunday = out.people.find((p: any) => p.id === 1).days[0];
    expect(sunday.tasks).toEqual([
      { taskId: 11, code: 'OK-1', name: 'Visible task', projectId: 59, projectName: 'Open project', hours: 2 },
      { taskId: null, code: null, name: 'Other project', projectId: null, projectName: null, hours: 1, masked: true },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/Secret|SEC-1/);
    // Admin / all-projects caller sees the names.
    const admin: any = await makeService({ people: 2, accessible: { all: true, projectIds: [] } }).svc.getTeamWorkload(
      { id: 99, isAdmin: true }, { from: WEEK_FROM, to: WEEK_TO },
    );
    expect(JSON.stringify(admin)).toContain('Secret task');
  });

  it('undated tasks are off the days and counted in undatedHours', async () => {
    const { svc } = makeService({ people: 2 });
    const out: any = await svc.getTeamWorkload({ id: 1, isAdmin: false }, { from: WEEK_FROM, to: WEEK_TO });
    const p2 = out.people.find((p: any) => p.id === 2);
    expect(p2.totals).toMatchObject({ planned: 0, undatedHours: 7 });
    expect(p2.days.every((d: any) => d.tasks.length === 0)).toBe(true);
    expect(out.totals.undatedHours).toBe(7);
  });

  it('orgUnitId narrows to the unit and its sub-units; myDeptOnly uses the caller’s unit', async () => {
    const { svc, prisma } = makeService({ people: 2 });
    const out: any = await svc.getTeamWorkload({ id: 1, isAdmin: false }, { orgUnitId: '5', from: WEEK_FROM, to: WEEK_TO });
    expect(prisma.user.findMany.mock.calls[0][0].where.orgUnitId).toEqual({ in: [5, 7] });
    expect(out.scope).toMatchObject({ orgUnitId: 5, deptName: 'BIM', myDeptOnly: false });
    expect(out.orgUnits.map((u: any) => u.name)).toEqual(['BIM', 'MEP', 'BIM North']);

    const mine = makeService({ people: 2 });
    const res: any = await mine.svc.getTeamWorkload({ id: 1, isAdmin: false }, { myDeptOnly: 'true', from: WEEK_FROM, to: WEEK_TO });
    expect(mine.prisma.user.findMany.mock.calls[0][0].where.orgUnitId).toEqual({ in: [5, 7] });
    expect(res.scope).toMatchObject({ myDeptOnly: true, orgUnitId: 5 });
  });

  it('rejects a bad or too long range', async () => {
    const { svc } = makeService({ people: 1 });
    for (const q of [{ from: '2026-11-22' }, { from: 'x', to: 'y' }, { from: '2026-11-28', to: '2026-11-22' }, { from: '2026-01-01', to: '2026-12-31' }, { weekOf: 'soon' }, { orgUnitId: 'abc' }]) {
      await expect(svc.getTeamWorkload({ id: 1, isAdmin: false }, q as any)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('subtreeUnitIds follows the path and parentId', () => {
    expect(subtreeUnitIds(5, [{ id: 5, parentId: null, path: '/5/' }, { id: 7, parentId: 5, path: '/' }, { id: 8, parentId: 7, path: null }, { id: 6, parentId: null, path: '/6/' }]).sort()).toEqual([5, 7, 8]);
  });

  it('the controller passes the caller, his visible ids and the query', async () => {
    const eps: any = { getTeamWorkload: jest.fn(async () => ({})) };
    const scope: any = { visibleUserIds: jest.fn(async () => [7, 30]) };
    const ctrl = new ExecutionPlanningController(eps, {} as any, scope);
    await ctrl.getTeamWorkload({ id: 7, isAdmin: false }, '2026-11-22', '2026-11-26', undefined, '5', undefined);
    expect(eps.getTeamWorkload).toHaveBeenCalledWith(
      { id: 7, isAdmin: false, visibleUserIds: [7, 30] },
      { from: '2026-11-22', to: '2026-11-26', weekOf: undefined, orgUnitId: '5', myDeptOnly: undefined },
    );
  });
});
