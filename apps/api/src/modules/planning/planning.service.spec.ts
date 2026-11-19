/**
 * GET /projects/:id/planning-data — dependency edges with a soft-deleted
 * predecessor are not shipped (2026-11-19).
 *
 * Task delete is a soft delete and keeps the TaskDependency rows so a
 * restore brings the edges back. The soft-delete middleware only filters
 * the top-level query, so the nested `dependencies` include has to drop
 * those edges itself — otherwise the planning ⛓ badge, the Kanban card
 * and the predecessor-conflict warning all count a deleted task.
 *
 * Prisma is mocked; any model call the read makes on an empty project
 * resolves to an empty result.
 */
import { PlanningService } from './planning.service';

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
          models.set(
            key,
            new Proxy({}, { get: (_t, method: string) => jest.fn(async () => emptyFor(method)) }),
          );
        }
        return models.get(key);
      },
    },
  ) as any;
}

describe('PlanningService.getPlanningData — dependency edges', () => {
  it('loads predecessors through a live-end filter and keeps the embedded shape the FE reads', async () => {
    const taskFindMany = jest.fn(async () => []);
    const prisma = makePrisma({
      project: { findFirstOrThrow: jest.fn(async () => ({ id: 59, name: 'P', status: 'active', budget: null })) },
      task: { findMany: taskFindMany },
    });
    const service = new PlanningService(prisma);

    await service.getPlanningData(59);

    const tasksCall = (taskFindMany.mock.calls as any[]).find((c) => c[0]?.include?.dependencies);
    expect(tasksCall).toBeDefined();
    const deps = tasksCall[0].include.dependencies;
    expect(deps.where).toEqual({ dependsOn: { deletedAt: null } });
    expect(deps.include.dependsOn.select).toEqual({ id: true, code: true, name: true, endDate: true });
  });
});
