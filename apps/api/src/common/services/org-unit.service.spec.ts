import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrgUnitService } from './org-unit.service';
import { ProjectAccessService } from './project-access.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * OrgUnitService — structural CRUD over the org tree.
 *
 * The tests focus on the invariants a downstream ProjectAccessService
 * consumer relies on:
 *   - path is always "/…/id/" (leading + trailing slash, self-inclusive)
 *   - depth mirrors path (slashes − 1) and re-anchors on move
 *   - move rewrites the entire subtree in one transaction
 *   - cycles are rejected (self-parent, descendant-parent)
 *   - each mutating method wipes the subordinate cache
 *
 * We don't test the underlying Prisma behavior — we assert what the
 * service asks Prisma to do, via a jest.fn() shim. That mirrors the
 * existing project-access.service.spec.ts style.
 */
describe('OrgUnitService', () => {
  let service: OrgUnitService;
  let projectAccess: { invalidateSubordinateCache: jest.Mock };
  let prisma: any;

  beforeEach(async () => {
    // The transaction callback receives a tx client with the same shape
    // as the top-level prisma client — we hand it the same jest.fn()
    // shims so assertions cover both direct and in-transaction calls.
    const txClient = {
      orgUnit: {
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    prisma = {
      $transaction: jest.fn(async (cb: any) => cb(txClient)),
      _tx: txClient,
      orgUnit: {
        findFirst: jest.fn(),
        update: jest.fn(),
        // Added in feat/org-tree-admin for updateMeta / softDelete /
        // getTree / getMembers.
        findMany: jest.fn(),
        count: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        groupBy: jest.fn(),
      },
    };

    projectAccess = { invalidateSubordinateCache: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgUnitService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProjectAccessService, useValue: projectAccess },
      ],
    }).compile();

    service = moduleRef.get(OrgUnitService);
  });

  describe('create', () => {
    it('creates a root unit with path "/id/" and depth 0', async () => {
      prisma._tx.orgUnit.create.mockResolvedValue({ id: 7 });
      prisma._tx.orgUnit.update.mockResolvedValue({ id: 7, path: '/7/', depth: 0 });

      const result = await service.create({ name: 'Root' });

      // Depth 0 for a root.
      expect(prisma._tx.orgUnit.create.mock.calls[0][0].data.depth).toBe(0);
      // Path rewritten to include the new id.
      expect(prisma._tx.orgUnit.update.mock.calls[0][0].data.path).toBe('/7/');
      expect(result.path).toBe('/7/');
    });

    it('creates a child under an existing parent — path prefixed, depth+1', async () => {
      prisma._tx.orgUnit.findFirst.mockResolvedValue({ path: '/1/5/', depth: 1 });
      prisma._tx.orgUnit.create.mockResolvedValue({ id: 12 });
      prisma._tx.orgUnit.update.mockResolvedValue({ id: 12, path: '/1/5/12/', depth: 2 });

      await service.create({ name: 'Leaf', parentId: 5 });

      expect(prisma._tx.orgUnit.create.mock.calls[0][0].data.depth).toBe(2);
      expect(prisma._tx.orgUnit.update.mock.calls[0][0].data.path).toBe('/1/5/12/');
    });

    it('throws NotFoundException when parent does not exist', async () => {
      prisma._tx.orgUnit.findFirst.mockResolvedValue(null);
      await expect(service.create({ name: 'X', parentId: 99 })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('move', () => {
    it('rejects moving a unit onto itself', async () => {
      await expect(service.move(5, 5)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects moving under one of its own descendants (cycle)', async () => {
      // Unit /1/5/ moving under /1/5/12/ — descendant's path starts
      // with the moved unit's path.
      prisma._tx.orgUnit.findFirst
        .mockResolvedValueOnce({ id: 5, path: '/1/5/', depth: 1, parentId: 1 })
        .mockResolvedValueOnce({ path: '/1/5/12/', depth: 2 });

      await expect(service.move(5, 12)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recomputes path + depth for the moved unit AND every descendant', async () => {
      // Moving unit id=5 from /1/5/ to /2/5/.
      prisma._tx.orgUnit.findFirst
        .mockResolvedValueOnce({ id: 5, path: '/1/5/', depth: 1, parentId: 1 })
        .mockResolvedValueOnce({ path: '/2/', depth: 0 });
      // Subtree: the unit itself + one child + one grandchild.
      prisma._tx.orgUnit.findMany.mockResolvedValue([
        { id: 5, path: '/1/5/', depth: 1 },
        { id: 12, path: '/1/5/12/', depth: 2 },
        { id: 42, path: '/1/5/12/42/', depth: 3 },
      ]);
      prisma._tx.orgUnit.update.mockResolvedValue({});
      prisma._tx.orgUnit.findUnique.mockResolvedValue({ id: 5, path: '/2/5/', depth: 1 });

      await service.move(5, 2);

      const calls = prisma._tx.orgUnit.update.mock.calls;
      const byId = new Map(calls.map((c: any) => [c[0].where.id, c[0].data]));

      // Moved unit: path re-anchored, depth stays at 1 (new parent
      // depth 0 + 1), parentId flipped to the new parent.
      expect(byId.get(5)).toMatchObject({ path: '/2/5/', depth: 1, parentId: 2 });
      // Descendant: same depth-delta (0), parentId untouched.
      expect(byId.get(12)).toMatchObject({ path: '/2/5/12/', depth: 2 });
      expect(byId.get(12)).not.toHaveProperty('parentId');
      // Deeper descendant.
      expect(byId.get(42)).toMatchObject({ path: '/2/5/12/42/', depth: 3 });

      // Cache invalidated after mutation.
      expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalledWith();
    });

    it('supports moving to the root (newParentId=null)', async () => {
      prisma._tx.orgUnit.findFirst.mockResolvedValueOnce({ id: 5, path: '/1/5/', depth: 1, parentId: 1 });
      prisma._tx.orgUnit.findMany.mockResolvedValue([{ id: 5, path: '/1/5/', depth: 1 }]);
      prisma._tx.orgUnit.update.mockResolvedValue({});
      prisma._tx.orgUnit.findUnique.mockResolvedValue({ id: 5, path: '/5/', depth: 0 });

      await service.move(5, null);

      const update = prisma._tx.orgUnit.update.mock.calls[0][0].data;
      expect(update.path).toBe('/5/');
      expect(update.depth).toBe(0);
      expect(update.parentId).toBeNull();
    });

    it('throws NotFoundException when the moved unit is missing', async () => {
      prisma._tx.orgUnit.findFirst.mockResolvedValue(null);
      await expect(service.move(5, 1)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setManager', () => {
    it('updates managerUserId and invalidates the cache', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.user.findFirst.mockResolvedValue({ id: 7 });
      prisma.orgUnit.update.mockResolvedValue({ id: 5, managerUserId: 7 });

      await service.setManager(5, 7);

      expect(prisma.orgUnit.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { managerUserId: 7 },
      });
      expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalled();
    });

    it('supports clearing (userId=null) — no user lookup', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.orgUnit.update.mockResolvedValue({ id: 5, managerUserId: null });

      await service.setManager(5, null);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalled();
    });

    it('throws NotFoundException when the unit is missing', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue(null);
      await expect(service.setManager(5, 7)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when the user is missing', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.setManager(5, 7)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('assignUser', () => {
    it('sets orgUnitId on the user and invalidates the cache', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 3 });
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.user.update.mockResolvedValue({ id: 3, orgUnitId: 5 });

      await service.assignUser(3, 5);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { orgUnitId: 5 },
        select: { id: true, orgUnitId: true },
      });
      expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalled();
    });

    it('supports clearing (unitId=null) — no unit lookup', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 3 });
      prisma.user.update.mockResolvedValue({ id: 3, orgUnitId: null });

      await service.assignUser(3, null);
      expect(prisma.orgUnit.findFirst).not.toHaveBeenCalled();
      expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalled();
    });

    it('throws NotFoundException when user is missing', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.assignUser(3, 5)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when unit is missing', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 3 });
      prisma.orgUnit.findFirst.mockResolvedValue(null);
      await expect(service.assignUser(3, 5)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── feat/org-tree-admin additions ────────────────────────────────
  //
  // Three new service methods drive the admin page:
  //   updateMeta  — rename / re-code without touching path/depth
  //   softDelete  — set deletedAt; blocked if children or members
  //   getTree     — flat list + per-node member + subtree counts
  //   getMembers  — direct home-unit members of a node

  describe('updateMeta', () => {
    it('writes name + code and nothing else', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.orgUnit.update.mockResolvedValue({ id: 5, name: 'New', code: 'NEW' });

      await service.updateMeta(5, { name: 'New', code: 'NEW' });
      expect(prisma.orgUnit.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { name: 'New', code: 'NEW' },
      });
    });

    it('accepts partial updates (name only, code only)', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.orgUnit.update.mockResolvedValue({});
      await service.updateMeta(5, { name: 'Just a rename' });
      const data = prisma.orgUnit.update.mock.calls[0][0].data;
      expect(data).toEqual({ name: 'Just a rename' });
    });

    it('supports clearing the code (code=null)', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5 });
      prisma.orgUnit.update.mockResolvedValue({});
      await service.updateMeta(5, { code: null });
      expect(prisma.orgUnit.update.mock.calls[0][0].data).toEqual({ code: null });
    });

    it('throws NotFoundException when the unit is missing', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue(null);
      await expect(service.updateMeta(5, { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softDelete', () => {
    it('sets deletedAt when the unit has no children and no members', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5, path: '/5/', name: 'Marketing' });
      prisma.orgUnit.count.mockResolvedValue(0);
      prisma.user.count.mockResolvedValue(0);
      prisma.orgUnit.update.mockResolvedValue({ id: 5, deletedAt: expect.any(Date) });

      await service.softDelete(5);
      const data = prisma.orgUnit.update.mock.calls[0][0].data;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(projectAccess.invalidateSubordinateCache).toHaveBeenCalled();
    });

    it('BLOCKS delete with 400 when the unit has children', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5, path: '/5/', name: 'Engineering' });
      prisma.orgUnit.count.mockResolvedValue(3); // 3 sub-units
      prisma.user.count.mockResolvedValue(0);

      await expect(service.softDelete(5)).rejects.toBeInstanceOf(BadRequestException);
      // No update fired.
      expect(prisma.orgUnit.update).not.toHaveBeenCalled();
    });

    it('BLOCKS delete with 400 when the unit still has members', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue({ id: 5, path: '/5/', name: 'Support' });
      prisma.orgUnit.count.mockResolvedValue(0);
      prisma.user.count.mockResolvedValue(7); // 7 members

      await expect(service.softDelete(5)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.orgUnit.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the unit is missing', async () => {
      prisma.orgUnit.findFirst.mockResolvedValue(null);
      await expect(service.softDelete(5)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getTree', () => {
    it('returns flat units with direct + subtree member counts and subtree unit count', async () => {
      // Three-unit tree: root /1/ with two children /1/2/ and /1/3/.
      prisma.orgUnit.findMany.mockResolvedValue([
        { id: 1, name: 'Root', code: null, parentId: null, path: '/1/', depth: 0, sortOrder: 0, managerUserId: null, manager: null },
        { id: 2, name: 'Left', code: null, parentId: 1, path: '/1/2/', depth: 1, sortOrder: 0, managerUserId: null, manager: null },
        { id: 3, name: 'Right', code: null, parentId: 1, path: '/1/3/', depth: 1, sortOrder: 1, managerUserId: 7, manager: { id: 7, firstName: 'A', lastName: 'B', email: 'a@x', avatarUrl: null } },
      ]);
      // Direct member groupBy: unit 2 has 2 members, unit 3 has 1.
      prisma.user.groupBy.mockResolvedValue([
        { orgUnitId: 2, _count: { orgUnitId: 2 } },
        { orgUnitId: 3, _count: { orgUnitId: 1 } },
      ]);

      const tree = await service.getTree();
      const byId = new Map(tree.map((n) => [n.id, n]));

      // Root: 0 direct, 3 in subtree (2+1 via descendants), 3 units (self + 2 kids).
      expect(byId.get(1)).toMatchObject({ memberCount: 0, subtreeMemberCount: 3, subtreeUnitCount: 3 });
      // Left leaf.
      expect(byId.get(2)).toMatchObject({ memberCount: 2, subtreeMemberCount: 2, subtreeUnitCount: 1 });
      // Right leaf with manager passed through.
      expect(byId.get(3)).toMatchObject({ memberCount: 1, subtreeMemberCount: 1, subtreeUnitCount: 1, managerUserId: 7 });
      expect(byId.get(3)!.manager).toEqual({ id: 7, firstName: 'A', lastName: 'B', email: 'a@x', avatarUrl: null });
    });

    it('returns [] when there are no units', async () => {
      prisma.orgUnit.findMany.mockResolvedValue([]);
      prisma.user.groupBy.mockResolvedValue([]);
      expect(await service.getTree()).toEqual([]);
    });
  });

  describe('getMembers', () => {
    it('lists live users with orgUnitId = id, ordered by first+last', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 3 }, { id: 7 }]);
      const rows = await service.getMembers(5);
      expect(rows).toEqual([{ id: 3 }, { id: 7 }]);
      const call = prisma.user.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ orgUnitId: 5, deletedAt: null });
      expect(call.orderBy).toEqual([{ firstName: 'asc' }, { lastName: 'asc' }]);
    });
  });
});
