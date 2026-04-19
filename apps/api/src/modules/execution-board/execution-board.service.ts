import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ExecutionBoardService {
  constructor(private prisma: PrismaService) {}

  async getData(projectId?: number, serviceId?: number) {
    const projectWhere: any = {
      deletedAt: null,
    };
    if (projectId) projectWhere.id = projectId;

    const projects = await this.prisma.project.findMany({
      where: projectWhere,
      select: { id: true, name: true, number: true, status: true },
      orderBy: { name: 'asc' },
    });

    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) {
      return { projects: [], zones: {}, tasks: [], services: [], templates: [] };
    }

    const [flatZones, tasks, services, templates] = await Promise.all([
      this.prisma.zone.findMany({
        where: { projectId: { in: projectIds }, deletedAt: null },
        orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          deletedAt: null,
          isArchived: false,
          ...(serviceId ? { phaseId: serviceId } : {}),
        },
        include: {
          zone: { select: { id: true, name: true } },
          serviceType: { select: { id: true, name: true, code: true, color: true } },
          phase: { select: { id: true, name: true, color: true } },
          assignees: {
            where: { deletedAt: null },
            include: {
              user: {
                select: { id: true, firstName: true, lastName: true, avatarUrl: true },
              },
            },
          },
        },
        orderBy: [{ zoneId: 'asc' }, { sortOrder: 'asc' }],
      }),
      // DB Phase = UI "Services" (filter dropdown)
      this.prisma.phase.findMany({ orderBy: { sortOrder: 'asc' } }),
      // Phase/Milestone Templates (columns) — exclude the task catalog
      this.prisma.template.findMany({
        where: {
          type: 'task_list',
          code: { not: '__TASK_CATALOG__' },
          isActive: true,
        },
        select: { id: true, name: true, code: true, phaseId: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const zones: Record<number, any[]> = {};
    for (const pid of projectIds) {
      const projectZones = flatZones.filter((z) => z.projectId === pid);
      const zoneMap = new Map<number, any>();
      const roots: any[] = [];

      for (const z of projectZones) {
        zoneMap.set(z.id, { ...z, children: [] });
      }
      for (const z of projectZones) {
        const node = zoneMap.get(z.id);
        if (z.parentId && zoneMap.has(z.parentId)) {
          zoneMap.get(z.parentId).children.push(node);
        } else {
          roots.push(node);
        }
      }
      zones[pid] = roots;
    }

    return { projects, zones, tasks, services, templates };
  }
}
