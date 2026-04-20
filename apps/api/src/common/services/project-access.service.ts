import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Centralizes project-scoped authorization. Use this in any service that
 * accepts a project/zone/task ID from a request to make sure the caller
 * is actually a member of that project (or a super-admin).
 *
 * Without this check, any authenticated user with `tasks:read` permission
 * could read another tenant's tasks by guessing IDs (IDOR).
 */
@Injectable()
export class ProjectAccessService {
  constructor(private prisma: PrismaService) {}

  /**
   * Returns true for super-admins (roleId === 1) — they can see everything.
   */
  private isSuperAdmin(roleId?: number | null): boolean {
    return roleId === 1;
  }

  /**
   * Throws ForbiddenException if `userId` is not a member of `projectId`
   * and is not a super-admin. Throws NotFoundException if the project
   * does not exist (or is soft-deleted).
   */
  async assertProjectAccess(
    userId: number,
    projectId: number,
    roleId?: number | null,
  ): Promise<void> {
    if (this.isSuperAdmin(roleId)) return;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, leaderId: true, createdBy: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (project.leaderId === userId || project.createdBy === userId) return;

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      select: { id: true },
    });
    if (!membership) {
      throw new ForbiddenException('You do not have access to this project');
    }
  }

  /**
   * Resolves a task → projectId then asserts access. Returns the projectId.
   */
  async assertTaskAccess(
    userId: number,
    taskId: number,
    roleId?: number | null,
  ): Promise<number> {
    if (this.isSuperAdmin(roleId)) {
      const t = await this.prisma.task.findFirst({
        where: { id: taskId, deletedAt: null },
        select: { projectId: true },
      });
      if (!t) throw new NotFoundException('Task not found');
      return t.projectId;
    }

    const task = await this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { projectId: true },
    });
    if (!task) throw new NotFoundException('Task not found');

    await this.assertProjectAccess(userId, task.projectId, roleId);
    return task.projectId;
  }

  /**
   * Resolves a zone → projectId then asserts access. Returns the projectId.
   */
  async assertZoneAccess(
    userId: number,
    zoneId: number,
    roleId?: number | null,
  ): Promise<number> {
    if (this.isSuperAdmin(roleId)) {
      const z = await this.prisma.zone.findFirst({
        where: { id: zoneId, deletedAt: null },
        select: { projectId: true },
      });
      if (!z) throw new NotFoundException('Zone not found');
      return z.projectId;
    }

    const zone = await this.prisma.zone.findFirst({
      where: { id: zoneId, deletedAt: null },
      select: { projectId: true },
    });
    if (!zone) throw new NotFoundException('Zone not found');

    await this.assertProjectAccess(userId, zone.projectId, roleId);
    return zone.projectId;
  }

  /**
   * Returns the set of project IDs the user can access. Super-admins
   * get an empty set (callers should treat empty + super-admin as "all").
   * Used for filtering list endpoints (e.g. execution-board).
   */
  async getAccessibleProjectIds(
    userId: number,
    roleId?: number | null,
  ): Promise<{ all: boolean; projectIds: number[] }> {
    if (this.isSuperAdmin(roleId)) return { all: true, projectIds: [] };

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const led = await this.prisma.project.findMany({
      where: { OR: [{ leaderId: userId }, { createdBy: userId }], deletedAt: null },
      select: { id: true },
    });
    const ids = new Set<number>();
    for (const m of memberships) ids.add(m.projectId);
    for (const p of led) ids.add(p.id);
    return { all: false, projectIds: [...ids] };
  }
}
