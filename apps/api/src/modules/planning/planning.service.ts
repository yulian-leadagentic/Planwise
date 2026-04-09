import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PlanningService {
  constructor(private prisma: PrismaService) {}

  async getPlanningData(projectId: number) {
    const project = await this.prisma.project.findFirstOrThrow({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, status: true, budget: true },
    });

    // Zone tree
    const flatZones = await this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      include: { zoneServiceTypes: { include: { serviceType: true } } },
      orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
    });
    const zoneMap = new Map<number, any>();
    const zoneRoots: any[] = [];
    for (const zone of flatZones) {
      zoneMap.set(zone.id, { ...zone, children: [] });
    }
    for (const zone of flatZones) {
      const node = zoneMap.get(zone.id);
      if (zone.parentId && zoneMap.has(zone.parentId)) {
        zoneMap.get(zone.parentId).children.push(node);
      } else {
        zoneRoots.push(node);
      }
    }

    // Tasks
    const tasks = await this.prisma.task.findMany({
      where: { projectId, deletedAt: null, isArchived: false },
      include: {
        zone: { select: { id: true, name: true, zoneType: true } },
        serviceType: true,
        phase: true,
        dependencies: { include: { dependsOn: { select: { id: true, code: true, name: true } } } },
        assignees: {
          where: { deletedAt: null },
          include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
        },
      },
      orderBy: [{ zoneId: 'asc' }, { serviceTypeId: 'asc' }, { createdAt: 'asc' }],
    });

    // Project members
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });

    // Lookups
    const serviceTypes = await this.prisma.serviceType.findMany({ orderBy: { sortOrder: 'asc' } });
    const phases = await this.prisma.phase.findMany({ orderBy: { sortOrder: 'asc' } });

    // Aggregate logged time per task
    const timeAgg = await this.prisma.timeEntry.groupBy({
      by: ['taskId'],
      where: { projectId, deletedAt: null, taskId: { not: null } },
      _sum: { minutes: true },
    });
    const loggedByTask = new Map<number, number>();
    for (const row of timeAgg) {
      if (row.taskId) loggedByTask.set(row.taskId, row._sum.minutes ?? 0);
    }

    // Attach loggedMinutes to each task
    const tasksWithLogged = tasks.map((t) => ({
      ...t,
      loggedMinutes: loggedByTask.get(t.id) ?? 0,
    }));

    // Budget summary
    const totalHours = tasks.reduce((s, t) => s + Number(t.budgetHours || 0), 0);
    const totalAmount = tasks.reduce((s, t) => s + Number(t.budgetAmount || 0), 0);
    const totalLoggedMinutes = tasksWithLogged.reduce((s, t) => s + t.loggedMinutes, 0);
    const topDown = project.budget ? Number(project.budget) : 0;

    return {
      project: { id: project.id, name: project.name, status: project.status, budget: topDown },
      zones: zoneRoots,
      tasks: tasksWithLogged,
      members,
      serviceTypes,
      phases,
      budgetSummary: {
        totalHours,
        totalAmount,
        totalLoggedMinutes,
        totalLoggedHours: Math.round(totalLoggedMinutes / 60 * 100) / 100,
        projectBudget: topDown,
        remaining: topDown - totalAmount,
        remainingPct: topDown > 0 ? Math.round((topDown - totalAmount) / topDown * 10000) / 100 : 0,
      },
    };
  }
}
