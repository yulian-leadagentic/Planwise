/**
 * Dependency cycle guard ignores edges through soft-deleted tasks
 * (2026-11-19).
 *
 * Task delete is a soft delete and keeps its TaskDependency rows (a
 * restore brings them back). `assertNoCycle` used to walk those edges
 * too, so a path through a deleted task — one the PM can't see or break
 * — reported "Dependency cycle detected" on a perfectly valid edge.
 *
 * The prisma fake below applies the `where` the service sends (live
 * ends only), so the specs prove the query asks for the filter rather
 * than asserting on a mocked return value.
 */
import { BadRequestException } from '@nestjs/common';

import { ProjectsService } from './projects.service';

type Edge = { taskId: number; dependsOnId: number };

function makeService(edges: Edge[], deletedTaskIds: number[]) {
  const deleted = new Set(deletedTaskIds);
  const liveEnds = (where: any) => (e: Edge) =>
    !(where?.task?.deletedAt === null && deleted.has(e.taskId)) &&
    !(where?.dependsOn?.deletedAt === null && deleted.has(e.dependsOnId));
  const prisma: any = {
    taskDependency: {
      findMany: jest.fn(async ({ where }: any) => edges.filter(liveEnds(where))),
      findFirst: jest.fn(async ({ where }: any) =>
        edges.filter(liveEnds(where)).find((e) => e.taskId === where.taskId && e.dependsOnId === where.dependsOnId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data, dependsOn: { id: data.dependsOnId } })),
    },
    task: {
      findUnique: jest.fn(async ({ where }: any) => ({ projectId: 59, code: `T-${where.id}` })),
    },
  };
  const service = new ProjectsService(prisma, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

describe('ProjectsService.addDependency — cycle guard over the live graph', () => {
  it('a path through a soft-deleted task is not a cycle', async () => {
    // 9 is deleted. Live graph: nothing. Stored rows: 9 → 1 and 2 → 9,
    // so walking them from 2 would reach 1 and "close" 1 → 2.
    const { service, prisma } = makeService(
      [
        { taskId: 9, dependsOnId: 1 },
        { taskId: 2, dependsOnId: 9 },
      ],
      [9],
    );

    const out = await service.addDependency(1, { dependsOnId: 2 });

    expect(out).toMatchObject({ taskId: 1, dependsOnId: 2, needsReschedule: true });
    expect(prisma.taskDependency.create).toHaveBeenCalledTimes(1);
    const where = prisma.taskDependency.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ task: { projectId: 59, deletedAt: null }, dependsOn: { deletedAt: null } });
  });

  it('a reverse edge to a soft-deleted task is not a direct cycle either', async () => {
    // Stored 2 → 1 where 2 is deleted; adding 1 → 2 must not trip the
    // A→B→A fast check. (2 itself being deleted is then refused by the
    // live-task lookup in the real service; here only the guard runs.)
    const { service, prisma } = makeService([{ taskId: 2, dependsOnId: 1 }], [2]);

    await service.addDependency(1, { dependsOnId: 2 });

    expect(prisma.taskDependency.findFirst.mock.calls[0][0].where).toMatchObject({
      task: { deletedAt: null },
      dependsOn: { deletedAt: null },
      taskId: 2,
      dependsOnId: 1,
    });
    expect(prisma.taskDependency.create).toHaveBeenCalledTimes(1);
  });

  it('a real cycle through live tasks is still refused', async () => {
    const { service, prisma } = makeService(
      [
        { taskId: 2, dependsOnId: 3 },
        { taskId: 3, dependsOnId: 1 },
      ],
      [],
    );

    await expect(service.addDependency(1, { dependsOnId: 2 })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.taskDependency.create).not.toHaveBeenCalled();
  });
});
