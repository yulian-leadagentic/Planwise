/**
 * Permissions round 4 (2026-11-23) — a zone's parent is in the same
 * project: create, copy-structure and reorder refuse a parent from
 * another project (400 CROSS_PROJECT_PARENT).
 */
import { BadRequestException } from '@nestjs/common';

import { ZonesService } from './zones.service';

function makeService() {
  const prisma: any = {
    zone: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(async (args: any) => ({ id: 500, ...args.data })),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
    },
    $transaction: jest.fn(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma))),
  };
  const service = new ZonesService(prisma, {} as any, {} as any);
  return { service, prisma };
}

const codeOf = (err: any) => (err instanceof BadRequestException ? (err.getResponse() as any).code : err);

describe('ZonesService.create — parent in the same project', () => {
  it('a parent from another project → 400 CROSS_PROJECT_PARENT, nothing created', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findFirst.mockResolvedValueOnce({ id: 70, projectId: 60, path: '70', depth: 0 });
    const err = await service.create({ projectId: 59, parentId: 70, name: 'L2' } as any).catch((e) => e);
    expect(codeOf(err)).toBe('CROSS_PROJECT_PARENT');
    expect(prisma.zone.create).not.toHaveBeenCalled();
  });

  it('a parent from the same project is accepted', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findFirst
      .mockResolvedValueOnce({ id: 12, projectId: 59, path: '12', depth: 0 })
      .mockResolvedValueOnce(null); // no sibling yet
    const zone = await service.create({ projectId: 59, parentId: 12, name: 'L2' } as any);
    expect(prisma.zone.create).toHaveBeenCalled();
    expect(zone.path).toBe('12/500');
  });
});

describe('ZonesService.copyStructure — target parent in the source project', () => {
  it('a target parent from another project → CROSS_PROJECT_PARENT, nothing copied', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findFirst
      .mockResolvedValueOnce({ id: 12, projectId: 59, children: [] })
      .mockResolvedValueOnce({ id: 70, projectId: 60, path: '70', depth: 0 });
    const err = await service.copyStructure(12, 70).catch((e) => e);
    expect(codeOf(err)).toBe('CROSS_PROJECT_PARENT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('ZonesService.batchReorder — new parent in the same project', () => {
  it('a parent from another project → CROSS_PROJECT_PARENT, nothing written', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findMany.mockResolvedValue([
      { id: 12, projectId: 59 },
      { id: 70, projectId: 60 },
    ]);
    const err = await service.batchReorder([{ id: 12, sortOrder: 1000, parentId: 70 }]).catch((e) => e);
    expect(codeOf(err)).toBe('CROSS_PROJECT_PARENT');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a parent from the same project (or the root) is accepted', async () => {
    const { service, prisma } = makeService();
    prisma.zone.findMany.mockResolvedValue([
      { id: 12, projectId: 59 },
      { id: 13, projectId: 59 },
    ]);
    await service.batchReorder([
      { id: 12, sortOrder: 1000, parentId: 13 },
      { id: 14, sortOrder: 2000, parentId: null },
    ]);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.zone.update).toHaveBeenCalledWith({ where: { id: 12 }, data: { sortOrder: 1000, parentId: 13 } });
  });
});
