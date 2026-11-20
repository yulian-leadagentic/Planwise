/**
 * Permissions round 2 (2026-11-20) — B-07: `GET /projects/:id/planning-data`
 * no longer ships money to project members without finance:read.
 *
 * Ambiguous names (`project.budget`, `budgetSummary.totalAmount /
 * projectBudget / remaining / remainingPct`) are stripped by the
 * controller; per-task `budgetAmount`, `actualCost` and assignee
 * `hourlyRate` too (and by the global interceptor as a second layer).
 * Hours (`budgetHours`, `loggedMinutes`, `budgetSummary.totalHours`)
 * stay. Prisma is mocked (same proxy pattern as planning.service.spec).
 */
import { Prisma } from '@prisma/client';

import { PlanningController } from './planning.controller';
import { PlanningService, redactPlanningMoney } from './planning.service';
import { redactFinanceFields } from '../../common/finance/finance-access';

function makePrisma(overrides: Record<string, any>) {
  const emptyFor = (method: string) => {
    if (method === 'findMany' || method === 'groupBy') return [];
    if (method === 'count') return 0;
    if (method === 'aggregate') return { _sum: {}, _max: {}, _min: {}, _count: 0 };
    return null;
  };
  const models = new Map<string, any>();
  return new Proxy(
    {},
    {
      get(_target, key: string) {
        if (key in overrides) return overrides[key];
        if (key.startsWith('$')) return jest.fn(async () => []);
        if (!models.has(key)) {
          models.set(key, new Proxy({}, { get: (_t, method: string) => jest.fn(async () => emptyFor(method)) }));
        }
        return models.get(key);
      },
    },
  ) as any;
}

const task = {
  id: 11,
  name: 'Model L2',
  projectId: 59,
  zoneId: null,
  zone: null,
  projectDeliverableId: null,
  budgetHours: new Prisma.Decimal('16'),
  budgetAmount: new Prisma.Decimal('4800'),
  assignees: [{ userId: 7, hourlyRate: new Prisma.Decimal('120'), user: { id: 7, firstName: 'Dana' } }],
  dependencies: [],
  _count: { comments: 0 },
};

function makeController() {
  const prisma = makePrisma({
    project: { findFirstOrThrow: jest.fn(async () => ({ id: 59, name: 'Tower A', status: 'active', budget: new Prisma.Decimal('900000') })) },
    task: { findMany: jest.fn(async () => [task]) },
  });
  const service = new PlanningService(prisma);
  const access: any = { assertProjectAccess: jest.fn(async () => undefined) };
  return new PlanningController(service, access);
}

const EMPLOYEE = { id: 2, isAdmin: false, roleModules: [{ module: { route: '/projects' }, canRead: true }] };
const FINANCE = { id: 3, isAdmin: false, roleModules: [{ module: { route: '/finance' }, canRead: true }] };

describe('GET /projects/:id/planning-data — money (B-07)', () => {
  it('a member without finance:read gets hours but no money', async () => {
    const out: any = await makeController().getPlanningData(EMPLOYEE, 59);
    expect(out.project).toEqual({ id: 59, name: 'Tower A', status: 'active' });
    expect(out.budgetSummary).toEqual({ totalHours: 16, totalLoggedMinutes: 0, totalLoggedHours: 0 });
    const t = out.tasks[0];
    expect(t).not.toHaveProperty('budgetAmount');
    expect(t).not.toHaveProperty('actualCost');
    expect(t).not.toHaveProperty('actualCostCurrency');
    expect(t.assignees[0]).not.toHaveProperty('hourlyRate');
    expect(t.assignees[0].user).toEqual({ id: 7, firstName: 'Dana' });
    expect(Number(t.budgetHours)).toBe(16);
    expect(t.loggedMinutes).toBe(0);
  });

  it('a finance:read caller gets the budget summary and per-task money', async () => {
    const out: any = await makeController().getPlanningData(FINANCE, 59);
    expect(out.project.budget).toBe(900000);
    expect(out.budgetSummary).toMatchObject({ totalAmount: 4800, projectBudget: 900000, remaining: 895200 });
    expect(Number(out.tasks[0].budgetAmount)).toBe(4800);
    expect(out.tasks[0].actualCost).toBe(0);
  });

  it('the global interceptor finds nothing left to strip in the redacted payload', async () => {
    const out: any = await makeController().getPlanningData(EMPLOYEE, 59);
    expect(redactFinanceFields(out)).toBe(out);
  });

  it('redactPlanningMoney is pure', () => {
    const data = { project: { id: 1, budget: 5 }, budgetSummary: { totalHours: 1, remaining: 2 }, tasks: [{ id: 1, budgetAmount: 3 }] };
    const snapshot = JSON.stringify(data);
    redactPlanningMoney(data);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});
