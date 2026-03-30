import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PlanningService {
  constructor(private prisma: PrismaService) {}

  async getPlanningData(projectId: number) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, status: true, budget: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Fetch zones and build tree
    const flatZones = await this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      include: { zoneType: true },
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

    // Fetch services with deliverables and assignments
    const services = await this.prisma.service.findMany({
      where: { projectId, deletedAt: null },
      include: {
        deliverables: {
          where: { deletedAt: null },
          include: {
            assignments: {
              where: { deletedAt: null },
              include: {
                zone: true,
                assignees: {
                  where: { deletedAt: null },
                  include: {
                    user: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                      },
                    },
                  },
                },
              },
            },
            zoneAssignments: { include: { zone: true } },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    // Calculate budget summary
    const allAssignments = services.flatMap((s) =>
      s.deliverables.flatMap((d) => d.assignments),
    );

    const bottomUp = allAssignments.reduce((sum, a) => {
      const hours = a.budgetHours ? Number(a.budgetHours) : 0;
      return sum + hours;
    }, 0);

    const topDown = project.budget ? Number(project.budget) : 0;
    const variance = topDown - bottomUp;
    const variancePct = topDown > 0 ? (variance / topDown) * 100 : 0;

    return {
      project: {
        id: project.id,
        name: project.name,
        status: project.status,
      },
      zones: zoneRoots,
      services,
      budgetSummary: {
        bottomUp,
        topDown,
        variance,
        variancePct: Math.round(variancePct * 100) / 100,
      },
    };
  }
}
