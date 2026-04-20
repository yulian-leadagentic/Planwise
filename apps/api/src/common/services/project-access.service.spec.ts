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
});
