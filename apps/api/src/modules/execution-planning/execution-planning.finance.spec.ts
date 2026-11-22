/**
 * Permissions round 2 (2026-11-20).
 *
 *   • B-11: `GET /dashboard/operations` — without finance:read the
 *     at-risk rows carry no budget / budgetUsed / budgetPct (any two give
 *     the third away), no "Budget X% used" risk factor, and the row
 *     status ignores budget (otherwise a reasonless "critical" still
 *     tells the reader the budget is over 85% used).
 *   • B-04: `GET /projects/:id/estimated-cost` (salaryHourly as "rate"
 *     to every project member) is gone.
 */
import { PATH_METADATA } from '@nestjs/common/constants';

import { ExecutionPlanningController } from './execution-planning.controller';
import { ExecutionPlanningService } from './execution-planning.service';

function makeService() {
  // Project budget 1000, task budgets sum to 900 (90% used), 0 hours
  // logged against 10 budget hours (0% progress) → the budget rule makes
  // the row "critical" for a finance reader.
  const prisma: any = {
    user: { findUnique: jest.fn(async () => ({ orgUnitId: null, orgUnit: null })), findMany: jest.fn(async () => []) },
    project: {
      findMany: jest.fn(async () => [
        { id: 59, name: 'Tower A', number: '1001', budget: '1000.00', endDate: null, leader: null, department: null },
      ]),
    },
    task: {
      findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      aggregate: jest.fn(async () => ({ _sum: { budgetAmount: '900.00', budgetHours: '10' }, _count: 1 })),
    },
    timeEntry: { aggregate: jest.fn(async () => ({ _sum: { minutes: 0 } })), groupBy: jest.fn(async () => []) },
    taskAssignee: { groupBy: jest.fn(async () => []) },
  };
  const access: any = { getAccessibleProjectIds: jest.fn(async () => ({ all: true, projectIds: [] })) };
  return new ExecutionPlanningService(prisma, access);
}

describe('GET /dashboard/operations — budget (B-11)', () => {
  it('a finance reader sees budget, budgetUsed, budgetPct and the budget risk factor', async () => {
    const out: any = await makeService().getOperationsDashboard({ id: 1, isAdmin: true, canSeeFinance: true });
    const row = out.projects.find((p: any) => p.id === 59);
    expect(row).toMatchObject({ budget: 1000, budgetUsed: 900, budgetPct: 90, status: 'critical' });
    expect(row.riskFactors.map((r: any) => r.text)).toContain('Budget 90% used with only 0% progress');
  });

  it('without finance:read: no budget fields, no budget text, status not driven by budget', async () => {
    const out: any = await makeService().getOperationsDashboard({ id: 2, isAdmin: false, canSeeFinance: false });
    const row = out.projects.find((p: any) => p.id === 59);
    // the project was only at risk because of its budget → not listed
    expect(row).toBeUndefined();
    for (const p of out.projects) {
      expect(p).not.toHaveProperty('budget');
      expect(p).not.toHaveProperty('budgetUsed');
      expect(p).not.toHaveProperty('budgetPct');
      expect(JSON.stringify(p.riskFactors)).not.toMatch(/budget/i);
    }
  });

  it('a caller that does not say is treated as non-finance (fail closed)', async () => {
    const out: any = await makeService().getOperationsDashboard({ id: 2, isAdmin: true });
    expect(JSON.stringify(out.projects)).not.toMatch(/budget/i);
  });

  it('the controller passes the caller’s finance grant (an Admin without the grant is non-finance)', async () => {
    const eps: any = { getOperationsDashboard: jest.fn(async () => ({})) };
    // Round 3 — the controller also passes the caller's visible user ids.
    const scope: any = { visibleUserIds: jest.fn(async (u: any) => [u.id]) };
    const ctrl = new ExecutionPlanningController(eps, {} as any, scope);
    await ctrl.getOperationsDashboard({ id: 1, isAdmin: true, roleModules: [] });
    expect(eps.getOperationsDashboard).toHaveBeenLastCalledWith(
      { id: 1, isAdmin: true, canSeeFinance: false, visibleUserIds: [1] },
      undefined,
    );
    await ctrl.getOperationsDashboard({
      id: 3,
      isAdmin: false,
      roleModules: [{ module: { route: '/finance' }, canRead: true }],
    });
    expect(eps.getOperationsDashboard).toHaveBeenLastCalledWith(
      { id: 3, isAdmin: false, canSeeFinance: true, visibleUserIds: [3] },
      undefined,
    );
  });
});

describe('GET /projects/:id/estimated-cost (B-04)', () => {
  it('the route and its service method are gone', () => {
    const proto = ExecutionPlanningController.prototype as any;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .map((k) => Reflect.getMetadata(PATH_METADATA, proto[k]))
      .filter(Boolean);
    expect(paths).toContain('projects/:id/feasibility');
    expect(paths).not.toContain('projects/:id/estimated-cost');
    expect(proto.getEstimatedCost).toBeUndefined();
    expect((ExecutionPlanningService.prototype as any).calculateEstimatedCost).toBeUndefined();
  });
});
