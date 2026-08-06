import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectAccessService } from './project-access.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Security-critical tests — this service is the IDOR defense for every
 * project-scoped endpoint. A regression here would silently open cross-
 * tenant data access, so every access path gets a test.
 */
describe('ProjectAccessService', () => {
  let service: ProjectAccessService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      project: { findFirst: jest.fn(), findMany: jest.fn() },
      projectMember: { findFirst: jest.fn(), findMany: jest.fn() },
      task: { findFirst: jest.fn() },
      zone: { findFirst: jest.fn() },
      // OrgUnit + User surfaces used by the hierarchical-access
      // extension. Default to "no org data" so every pre-existing
      // test path behaves exactly as it did before the feature
      // (empty subordinate set → no widen).
      orgUnit: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProjectAccessService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(ProjectAccessService);
  });

  describe('assertProjectAccess', () => {
    it('bypasses all checks for super-admin (roleId=1)', async () => {
      await expect(service.assertProjectAccess(99, 1, 1)).resolves.toBeUndefined();
      expect(prisma.project.findFirst).not.toHaveBeenCalled();
      expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project does not exist', async () => {
      prisma.project.findFirst.mockResolvedValue(null);
      await expect(service.assertProjectAccess(1, 42, 2)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when project is soft-deleted', async () => {
      // Service queries with deletedAt: null, so a deleted project simply returns null
      prisma.project.findFirst.mockResolvedValue(null);
      await expect(service.assertProjectAccess(1, 42, 2)).rejects.toBeInstanceOf(NotFoundException);
      const call = prisma.project.findFirst.mock.calls[0][0];
      expect(call.where.deletedAt).toBeNull();
    });

    it('allows access when user is the project leader', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 1, createdBy: 99 });
      await expect(service.assertProjectAccess(1, 42, 2)).resolves.toBeUndefined();
      expect(prisma.projectMember.findFirst).not.toHaveBeenCalled(); // short-circuits
    });

    it('allows access when user is the project creator', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 1 });
      await expect(service.assertProjectAccess(1, 42, 2)).resolves.toBeUndefined();
    });

    it('allows access when user is a project member', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 88 });
      prisma.projectMember.findFirst.mockResolvedValue({ id: 7 });
      await expect(service.assertProjectAccess(1, 42, 2)).resolves.toBeUndefined();
    });

    it('rejects when user is neither leader, creator, nor member', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 88 });
      prisma.projectMember.findFirst.mockResolvedValue(null);
      await expect(service.assertProjectAccess(1, 42, 2)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertTaskAccess', () => {
    it('returns projectId without membership check for super-admin', async () => {
      prisma.task.findFirst.mockResolvedValue({ projectId: 42 });
      const pid = await service.assertTaskAccess(99, 10, 1);
      expect(pid).toBe(42);
      expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when task does not exist', async () => {
      prisma.task.findFirst.mockResolvedValue(null);
      await expect(service.assertTaskAccess(1, 10, 2)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('delegates to assertProjectAccess for the task\'s project', async () => {
      prisma.task.findFirst.mockResolvedValue({ projectId: 42 });
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 1, createdBy: 99 });

      const pid = await service.assertTaskAccess(1, 10, 2);
      expect(pid).toBe(42);
      expect(prisma.project.findFirst).toHaveBeenCalled();
    });

    it('propagates ForbiddenException from project check', async () => {
      prisma.task.findFirst.mockResolvedValue({ projectId: 42 });
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 88 });
      prisma.projectMember.findFirst.mockResolvedValue(null);

      await expect(service.assertTaskAccess(1, 10, 2)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertZoneAccess', () => {
    it('throws NotFoundException when zone does not exist', async () => {
      prisma.zone.findFirst.mockResolvedValue(null);
      await expect(service.assertZoneAccess(1, 5, 2)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolves zone → projectId and returns it', async () => {
      prisma.zone.findFirst.mockResolvedValue({ projectId: 42 });
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 1, createdBy: 99 });

      const pid = await service.assertZoneAccess(1, 5, 2);
      expect(pid).toBe(42);
    });
  });

  describe('getAccessibleProjectIds', () => {
    it('returns { all: true } for super-admin', async () => {
      const result = await service.getAccessibleProjectIds(1, 1);
      expect(result).toEqual({ all: true, projectIds: [] });
      expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
    });

    it('unions memberships and led projects', async () => {
      prisma.projectMember.findMany.mockResolvedValue([
        { projectId: 10 },
        { projectId: 20 },
      ]);
      prisma.project.findMany.mockResolvedValue([
        { id: 20 },  // overlaps with membership — deduplicated
        { id: 30 },  // user is leader
      ]);

      const result = await service.getAccessibleProjectIds(1, 2);
      expect(result.all).toBe(false);
      expect([...result.projectIds].sort((a, b) => a - b)).toEqual([10, 20, 30]);
    });

    it('returns empty list when user has no access', async () => {
      prisma.projectMember.findMany.mockResolvedValue([]);
      prisma.project.findMany.mockResolvedValue([]);

      const result = await service.getAccessibleProjectIds(1, 2);
      expect(result).toEqual({ all: false, projectIds: [] });
    });
  });

  // ─── Hierarchical access (feat/org-access) ──────────────────────
  //
  // These prove the new hierarchy paths on ProjectAccessService.
  // Coverage matrix (per the task spec):
  //   1. Empty org config → getAccessibleProjectIds identical to today
  //   2. Unit manager sees a subordinate's project (list + assert)
  //   3. PARENT-unit manager sees a grandchild's project (skip-level)
  //   4. Non-manager unaffected
  //   5. Super-admin unaffected
  //
  // The `orgUnit.findMany` / `user.findMany` mocks use call-index to
  // distinguish the "managed units" query from the "subtree union" query
  // — see getManagedSubtreeUnitIds for the two-query pattern.

  describe('hierarchical access — getSubordinateUserIds', () => {
    it('returns [] when the user manages no units', async () => {
      // No managed units — the first orgUnit.findMany returns [].
      prisma.orgUnit.findMany.mockResolvedValueOnce([]);
      const subs = await service.getSubordinateUserIds(1);
      expect(subs).toEqual([]);
      // Short-circuits: subtree query + user query never run.
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('expands a managed unit to all users in its subtree', async () => {
      // 1st findMany: which units does user 1 manage? → unit /1/.
      // 2nd findMany: which units live under /1/? → three of them.
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
      // Users whose home unit is in {1, 2, 3}, excluding the manager
      // (user 1) themselves.
      prisma.user.findMany.mockResolvedValue([{ id: 5 }, { id: 6 }]);

      const subs = await service.getSubordinateUserIds(1);
      expect(subs.sort((a, b) => a - b)).toEqual([5, 6]);

      // The user query should EXCLUDE the manager themselves — that's
      // what stops a manager from short-circuiting their own checks.
      const userWhere = prisma.user.findMany.mock.calls[0][0].where;
      expect(userWhere.id).toEqual({ not: 1 });
      expect(userWhere.orgUnitId).toEqual({ in: [1, 2, 3] });
    });

    it('memoizes per userId — second call skips prisma', async () => {
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 9 }]);

      const first = await service.getSubordinateUserIds(1);
      const second = await service.getSubordinateUserIds(1);
      expect(first).toEqual([9]);
      expect(second).toEqual([9]);
      // Only one round of queries despite two calls.
      expect(prisma.orgUnit.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    });

    it('invalidateSubordinateCache forces a refetch on the next call', async () => {
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 9 }]);

      await service.getSubordinateUserIds(1);
      service.invalidateSubordinateCache(1);
      await service.getSubordinateUserIds(1);
      expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('hierarchical access — getAccessibleProjectIds widen', () => {
    it('empty org config leaves the result identical to today', async () => {
      // No org data — orgUnit.findMany default mock returns [].
      prisma.projectMember.findMany.mockResolvedValue([{ projectId: 10 }]);
      prisma.project.findMany.mockResolvedValue([{ id: 20 }]);

      const result = await service.getAccessibleProjectIds(1, 2);
      expect(result.all).toBe(false);
      expect(result.projectIds.sort((a, b) => a - b)).toEqual([10, 20]);
      // Widen step never fired.
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('unit manager sees a subordinate\'s project', async () => {
      // Manager has NO direct memberships / led projects.
      prisma.projectMember.findMany.mockResolvedValueOnce([]);
      prisma.project.findMany.mockResolvedValueOnce([]);
      // But manages unit /1/ which contains user 5.
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 5 }]);
      // Widen: user 5 is a member of project 42.
      prisma.projectMember.findMany.mockResolvedValueOnce([{ projectId: 42 }]);
      prisma.project.findMany.mockResolvedValueOnce([]); // user 5 leads/created nothing

      const result = await service.getAccessibleProjectIds(1, 2);
      expect(result.projectIds).toEqual([42]);
    });

    it('PARENT-unit manager sees a grandchild-unit member (skip-level)', async () => {
      // Manager runs unit /1/ (the root). Grandchild unit /1/5/12/
      // holds user 7, who is a member of project 99.
      prisma.projectMember.findMany.mockResolvedValueOnce([]);
      prisma.project.findMany.mockResolvedValueOnce([]);
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        // The subtree query returns EVERY unit whose path starts with
        // "/1/" — including the grandchild /1/5/12/.
        .mockResolvedValueOnce([{ id: 1 }, { id: 5 }, { id: 12 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 7 }]);
      prisma.projectMember.findMany.mockResolvedValueOnce([{ projectId: 99 }]);
      prisma.project.findMany.mockResolvedValueOnce([]);

      const result = await service.getAccessibleProjectIds(1, 2);
      expect(result.projectIds).toEqual([99]);
    });

    it('non-manager is unaffected — result equals direct memberships alone', async () => {
      prisma.projectMember.findMany.mockResolvedValue([{ projectId: 3 }]);
      prisma.project.findMany.mockResolvedValue([]);
      // No managed units.
      prisma.orgUnit.findMany.mockResolvedValueOnce([]);

      const result = await service.getAccessibleProjectIds(1, 2);
      expect(result.projectIds).toEqual([3]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('super-admin bypass is unaffected by org tree', async () => {
      const result = await service.getAccessibleProjectIds(1, 1);
      expect(result).toEqual({ all: true, projectIds: [] });
      expect(prisma.orgUnit.findMany).not.toHaveBeenCalled();
    });
  });

  describe('hierarchical access — assertProjectAccess widen', () => {
    it('lets a manager into a subordinate\'s project (member path)', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 88 });
      // Direct-membership check fails.
      prisma.projectMember.findFirst.mockResolvedValueOnce(null);
      // Subordinate resolution.
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 5 }]);
      // Subordinate IS a member of the project.
      prisma.projectMember.findFirst.mockResolvedValueOnce({ id: 12 });

      await expect(service.assertProjectAccess(1, 42, 2)).resolves.toBeUndefined();
    });

    it('lets a manager into a subordinate\'s project (subordinate is leader)', async () => {
      // Subordinate leads the project.
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 5, createdBy: 88 });
      prisma.projectMember.findFirst.mockResolvedValueOnce(null);
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 5 }]);
      // Membership call for the subordinate widen is not expected —
      // the leader-in-subs check short-circuits before it.

      await expect(service.assertProjectAccess(1, 42, 2)).resolves.toBeUndefined();
    });

    it('still rejects when neither the caller nor any subordinate touches the project', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 88 });
      prisma.projectMember.findFirst.mockResolvedValueOnce(null);
      prisma.orgUnit.findMany
        .mockResolvedValueOnce([{ path: '/1/' }])
        .mockResolvedValueOnce([{ id: 1 }]);
      prisma.user.findMany.mockResolvedValue([{ id: 5 }]);
      prisma.projectMember.findFirst.mockResolvedValueOnce(null);

      await expect(service.assertProjectAccess(1, 42, 2)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects with pre-feature behaviour when caller manages nothing', async () => {
      prisma.project.findFirst.mockResolvedValue({ id: 42, leaderId: 99, createdBy: 88 });
      prisma.projectMember.findFirst.mockResolvedValueOnce(null);
      // No managed units — the widen step short-circuits.
      prisma.orgUnit.findMany.mockResolvedValueOnce([]);

      await expect(service.assertProjectAccess(1, 42, 2)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
