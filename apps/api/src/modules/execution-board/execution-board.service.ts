import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';

@Injectable()
export class ExecutionBoardService {
  constructor(
    private prisma: PrismaService,
    private access: ProjectAccessService,
  ) {}

  async getData(
    userId: number,
    roleId: number | null | undefined,
    projectId?: number,
    serviceId?: number,
  ) {
    // Project-scoped authorization: filter to projects the caller can see
    const accessible = await this.access.getAccessibleProjectIds(userId, roleId);
    if (projectId) {
      // explicit project filter — must be allowed
      await this.access.assertProjectAccess(userId, projectId, roleId);
    }

    const projectWhere: any = {
      deletedAt: null,
    };
    if (projectId) {
      projectWhere.id = projectId;
    } else if (!accessible.all) {
      projectWhere.id = { in: accessible.projectIds };
    }

    // Hard caps prevent the "god query" from exploding with real data.
    // Users who hit these can filter by project or service to narrow down.
    const MAX_PROJECTS = 50;
    const MAX_TASKS = 5000;

    const projects = await this.prisma.project.findMany({
      where: projectWhere,
      select: { id: true, name: true, number: true, status: true },
      orderBy: { name: 'asc' },
      take: MAX_PROJECTS,
    });

    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) {
      return { projects: [], zones: {}, tasks: [], services: [], templates: [], deliverables: [], truncated: false };
    }

    const [flatZones, tasks, services, templates, deliverables] = await Promise.all([
      this.prisma.zone.findMany({
        where: { projectId: { in: projectIds }, deletedAt: null },
        orderBy: [{ path: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          deletedAt: null,
          isArchived: false,
          // NOTE: server-side serviceId filter intentionally removed. The
          // "service" name a task belongs to can come from THREE places —
          // task.serviceType.name, task.phase.name, or a [SERVICE:xxx]
          // marker inside task.description (legacy/template flow). Most
          // existing data uses the description marker, so a FK-based
          // filter ends up empty. The frontend filters on getTaskPhaseName
          // (which handles all three) and gets it right by construction.
        },
        take: MAX_TASKS + 1,
        include: {
          zone: { select: { id: true, name: true } },
          // deliverableTemplate is the AUTHORITATIVE deliverable link —
          // it's what the project task table shows and what the user
          // actually assigns. The board must resolve the same dimension
          // so a task lands in the SAME deliverable column the user sees
          // in the table (previously the board ignored this and used the
          // legacy [SERVICE:xxx] marker / phase, so the two views drifted).
          deliverableTemplate: { select: { id: true, name: true } },
          // projectDeliverable is the AUTHORITATIVE, project-owned deliverable
          // (first-class entity). Its name/order/service belong to the project
          // and are what the PM and customer see. The board resolves columns
          // from this; deliverableTemplate is kept only for provenance/back-compat.
          projectDeliverable: {
            select: {
              id: true,
              name: true,
              sortOrder: true,
              serviceId: true,
              service: { select: { id: true, name: true, color: true } },
            },
          },
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
      // Services list — kept for backwards compatibility, but the frontend
      // no longer drives the filter from this. The dropdown is populated
      // from the unique getTaskPhaseName() values of the actual loaded tasks
      // (see execution-board-page.tsx). We still return the catalog so any
      // legacy reader doesn't break.
      this.prisma.phase.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.template.findMany({
        where: {
          type: 'task_list',
          code: { not: '__TASK_CATALOG__' },
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          code: true,
          phaseId: true,
          phase: { select: { id: true, name: true, color: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      // Per-project Deliverable instances — the authoritative column set for
      // the board. Returning these (not just deriving from tasks) means a
      // freshly-added deliverable with no tasks yet still shows as a column.
      this.prisma.projectDeliverable.findMany({
        where: { projectId: { in: projectIds }, deletedAt: null },
        orderBy: [{ projectId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          projectId: true,
          sourceTemplateId: true,
          serviceId: true,
          name: true,
          sortOrder: true,
          status: true,
          service: { select: { id: true, name: true, color: true } },
        },
      }),
    ]);

    // Aggregate logged time per task. Filter on the task ids we just
    // loaded rather than timeEntry.projectId — that column is NULL on
    // historical entries logged via the My Tasks / TaskDrawer paths
    // and would otherwise silently drop their hours from the board.
    const taskIds = tasks.map((t: any) => t.id);
    const timeAgg = taskIds.length === 0
      ? []
      : await this.prisma.timeEntry.groupBy({
          by: ['taskId'],
          where: { taskId: { in: taskIds }, deletedAt: null },
          _sum: { minutes: true },
          _max: { date: true },
        });
    const loggedByTask = new Map<number, { minutes: number; lastDate: Date | null }>();
    for (const row of timeAgg) {
      if (row.taskId) {
        loggedByTask.set(row.taskId, {
          minutes: row._sum.minutes ?? 0,
          lastDate: row._max.date ?? null,
        });
      }
    }

    // Enrich tasks with logged time data. The authoritative deliverable is
    // now task.projectDeliverable (a first-class, project-owned entity). To
    // keep the frontend resolver consistent during the migration window we
    // also mirror the project deliverable's name onto deliverableTemplate.name
    // (the resolver's priority-1 field) so columns / dropdown / filter all
    // reflect the project-owned label even before the resolver prefers
    // projectDeliverable directly. The template id is preserved.
    const tasksWithTime = tasks.map((t: any) => {
      const logged = loggedByTask.get(t.id);
      let deliverableTemplate = t.deliverableTemplate;
      if (t.projectDeliverable) {
        const name = t.projectDeliverable.name;
        if (deliverableTemplate) {
          deliverableTemplate = { ...deliverableTemplate, name };
        } else {
          // Task linked only to a project deliverable (no legacy template).
          deliverableTemplate = {
            id: t.projectDeliverable.sourceTemplateId ?? -t.projectDeliverable.id,
            name,
          };
        }
      }
      return {
        ...t,
        deliverableTemplate,
        loggedMinutes: logged?.minutes ?? 0,
        lastActivityDate: logged?.lastDate ?? null,
      };
    });

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

    // Drop the extra row used to detect truncation
    const truncated = tasks.length > MAX_TASKS;
    const finalTasks = truncated ? tasksWithTime.slice(0, MAX_TASKS) : tasksWithTime;
    return { projects, zones, tasks: finalTasks, services, templates, deliverables, truncated };
  }
}
