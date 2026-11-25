/**
 * QA6 PR-080 — Executive Review returns every open task in scope (it was
 * capped at 200: staging showed 200 of 341), with the department taken
 * from the project's org unit.
 * QA6 PR-061 — an open-ended project (end date 9999-12-31) gets no
 * days-left figure on the Operations risk rows.
 */
import { ExecutionPlanningService, EXECUTIVE_REVIEW_MAX_ROWS, isOpenEndedDate } from './execution-planning.service';

function execTask(i: number) {
  return {
    id: i, code: `T-${i}`, name: `Task ${i}`, status: 'in_progress', priority: 'medium',
    budgetHours: 2, endDate: null, startDate: null, updatedAt: new Date(),
    zone: null, phase: null, serviceType: null, assignees: [], opsNote: null,
    project: {
      id: 59, name: 'P', number: '1',
      orgUnit: i % 2 ? { id: 5, name: 'BIM' } : null,
      department: { id: 2, name: 'Legacy dept' },
    },
  };
}

function makeExec(total = 341) {
  const all = Array.from({ length: total }, (_, i) => execTask(i + 1));
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ({ orgUnitId: 5, orgUnit: { id: 5, name: 'BIM' } })) },
    project: { findMany: jest.fn(async () => [{ id: 59 }]) },
    task: {
      findMany: jest.fn(async ({ take }: any) => all.slice(0, take)),
      count: jest.fn(async () => all.length),
    },
  };
  const access: any = { getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })) };
  return { svc: new ExecutionPlanningService(prisma, access), prisma };
}

describe('Executive Review — no 200 cap (PR-080)', () => {
  it('returns all 341 tasks by default', async () => {
    const { svc, prisma } = makeExec(341);
    const out: any = await svc.getExecutiveReview({ id: 1, isAdmin: false });
    expect(out.tasks).toHaveLength(341);
    expect(out.totalCount).toBe(341);
    expect(out.truncated).toBe(false);
    expect(prisma.task.findMany.mock.calls[0][0].take).toBe(EXECUTIVE_REVIEW_MAX_ROWS);
  });

  it('an older client asking take=200 still gets 200 and is told the list is cut', async () => {
    const { svc } = makeExec(341);
    const out: any = await svc.getExecutiveReview({ id: 1, isAdmin: false }, undefined, '200');
    expect(out.tasks).toHaveLength(200);
    expect(out.truncated).toBe(true);
  });

  it('a junk take is ignored (full list); the guardrail caps a huge one', async () => {
    const { svc, prisma } = makeExec(30);
    await svc.getExecutiveReview({ id: 1, isAdmin: false }, undefined, 'abc');
    await svc.getExecutiveReview({ id: 1, isAdmin: false }, undefined, '999999');
    expect(prisma.task.findMany.mock.calls.map((c: any[]) => c[0].take)).toEqual([EXECUTIVE_REVIEW_MAX_ROWS, EXECUTIVE_REVIEW_MAX_ROWS]);
  });

  it('department = the project’s org unit, else the legacy department', async () => {
    const { svc } = makeExec(2);
    const out: any = await svc.getExecutiveReview({ id: 1, isAdmin: false });
    expect(out.tasks[0].project.department).toEqual({ id: 5, name: 'BIM' });
    expect(out.tasks[1].project.department).toEqual({ id: 2, name: 'Legacy dept' });
  });

  it('"My department only" still narrows the projects to the caller’s unit', async () => {
    const { svc, prisma } = makeExec(2);
    const out: any = await svc.getExecutiveReview({ id: 1, isAdmin: false }, 'true');
    expect(prisma.project.findMany.mock.calls[0][0].where.orgUnitId).toBe(5);
    expect(out.scope).toEqual({ myDeptOnly: true, deptName: 'BIM' });
  });
});

describe('Operations risk rows — open-ended projects (PR-061)', () => {
  it('isOpenEndedDate: 9999-12-31 (any year ≥ 9000) only', () => {
    expect(isOpenEndedDate(new Date('9999-12-31T00:00:00Z'))).toBe(true);
    expect(isOpenEndedDate('9999-12-31')).toBe(true);
    expect(isOpenEndedDate(new Date('2029-01-01'))).toBe(false);
    expect(isOpenEndedDate(null)).toBe(false);
  });

  it('no days-left figure and no deadline risk for a 9999-12-31 project', async () => {
    const overdue = {
      id: 1, code: 'T-1', name: 'T1', projectId: 59, endDate: new Date('2020-01-01'), budgetHours: 4, priority: 'high',
      status: 'in_progress', project: { id: 59, name: 'P', number: '1' }, zone: null, serviceType: null, dependencies: [], assignees: [],
    };
    const prisma: any = {
      user: { findUnique: jest.fn(async () => ({ orgUnitId: null, orgUnit: null })), findMany: jest.fn(async () => []) },
      project: {
        findMany: jest.fn(async () => [
          { id: 59, name: 'Open', number: '1', budget: 0, endDate: new Date('9999-12-31T00:00:00Z'), leader: null, department: null },
          { id: 60, name: 'Late', number: '2', budget: 0, endDate: new Date('2020-01-01T00:00:00Z'), leader: null, department: null },
        ]),
      },
      task: {
        findMany: jest.fn().mockResolvedValueOnce([overdue]).mockResolvedValueOnce([]),
        aggregate: jest.fn(async () => ({ _sum: { budgetAmount: 0, budgetHours: 0 }, _count: 0 })),
      },
      timeEntry: { aggregate: jest.fn(async () => ({ _sum: { minutes: 0 } })), groupBy: jest.fn(async () => []) },
      taskAssignee: { groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) },
      workSchedule: { findMany: jest.fn(async () => []) },
      absenceRecord: { findMany: jest.fn(async () => []) },
      hrSettings: { findFirst: jest.fn(async () => null) },
      calendarDay: { findMany: jest.fn(async () => []) },
    };
    const access: any = { getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })) };
    const out: any = await new ExecutionPlanningService(prisma, access).getOperationsDashboard({ id: 1, isAdmin: true });
    const open = out.projects.find((p: any) => p.id === 59);
    const late = out.projects.find((p: any) => p.id === 60);
    expect(open).toMatchObject({ openEnded: true, daysLeft: null });
    expect(open.riskFactors.some((r: any) => /Deadline/.test(r.text))).toBe(false);
    expect(late.openEnded).toBe(false);
    expect(late.daysLeft).toBeLessThan(0);
    expect(late.riskFactors.some((r: any) => /Deadline passed/.test(r.text))).toBe(true);
  });
});
