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

    // Zone tree. Order by sortOrder FIRST so drag-reorder persists in the
    // planning view (POST /zones/reorder writes sortOrder). Within zones
    // that share a sortOrder (e.g. all default 0) we fall back to createdAt
    // for a stable order. The tree is built by parentId in a second pass
    // below, so the flat-query order only affects sibling order at each
    // level — which is exactly what sortOrder controls.
    const flatZones = await this.prisma.zone.findMany({
      where: { projectId, deletedAt: null },
      include: { zoneServiceTypes: { include: { serviceType: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
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

    // Tasks. Order by sortOrder FIRST so drag-reorder actually persists in
    // the planning view (POST /tasks/reorder writes sortOrder; this endpoint
    // is what the planning UI reads back). createdAt is a stable tie-breaker
    // for tasks that haven't been reordered yet (sortOrder is still 0).
    const tasks = await this.prisma.task.findMany({
      where: { projectId, deletedAt: null, isArchived: false },
      include: {
        zone: { select: { id: true, name: true, zoneType: true } },
        serviceType: true,
        phase: true,
        // Source Deliverable (Template) — drives the planning grid's
        // "Group by Deliverable" labels so they match
        // /templates/deliverables exactly. Only id+name needed for
        // display; full template data is fetched on demand.
        deliverableTemplate: { select: { id: true, name: true } },
        dependencies: { include: { dependsOn: { select: { id: true, code: true, name: true } } } },
        assignees: {
          where: { deletedAt: null },
          include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
        },
      },
      orderBy: [{ zoneId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
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

    // Aggregate logged time per task. Filter by task ids (collected
    // from the project's tasks above) rather than timeEntry.projectId,
    // because that column can be NULL on entries created via the
    // /tasks/mine QuickTimeLog and TaskDrawer paths — those flows
    // didn't always thread the projectId through, so older rows have
    // project_id=NULL even though the linked task belongs to a project.
    // Resolving "is this entry on this project?" via task.id is the
    // safe path; it makes the aggregate immune to that data gap.
    const taskIds = tasks.map((t) => t.id);
    const timeAgg = taskIds.length === 0
      ? []
      : await this.prisma.timeEntry.groupBy({
          by: ['taskId'],
          where: { taskId: { in: taskIds }, deletedAt: null },
          _sum: { minutes: true },
        });
    const loggedByTask = new Map<number, number>();
    for (const row of timeAgg) {
      if (row.taskId) loggedByTask.set(row.taskId, row._sum.minutes ?? 0);
    }

    // M5 — per-task actual cost. Walk each entry, multiply hours by the
    // logger's SeniorityLevel.defaultHourlyCost, and sum per task. Same
    // resolution rule as the project Labor Cost view; entries where the
    // user has no seniority / no cost contribute 0 (we surface those gaps
    // in the Cost tab callout, no need to repeat per-row here).
    const entriesForCost = taskIds.length === 0
      ? []
      : await this.prisma.timeEntry.findMany({
          where: { taskId: { in: taskIds }, deletedAt: null },
          select: {
            taskId: true,
            minutes: true,
            user: {
              select: {
                seniorityLevel: { select: { defaultHourlyCost: true, currency: true } },
              },
            },
          },
        });
    // Per task: total cost + the currency seen on the first rateable
    // entry. If a task has contributors in multiple currencies the
    // numeric sum still reflects what was spent (no FX conversion); the
    // single currency tag tracks the first one — UI can call out mixed
    // currencies if needed but for v1 most orgs are single-currency.
    const actualByTask = new Map<number, { cost: number; currency: string | null }>();
    for (const e of entriesForCost) {
      if (e.taskId == null) continue;
      const hc = e.user.seniorityLevel?.defaultHourlyCost;
      if (hc == null) continue;
      const cost = (e.minutes / 60) * Number(hc);
      const curr = e.user.seniorityLevel?.currency ?? null;
      const prev = actualByTask.get(e.taskId);
      if (prev) {
        prev.cost += cost;
        if (!prev.currency) prev.currency = curr;
      } else {
        actualByTask.set(e.taskId, { cost, currency: curr });
      }
    }

    // Build a flat zoneId → name lookup from the zone tree. Used to
    // resolve each task's full zone breadcrumb so the planning grid
    // can show "Building 1 › Typical floor" instead of just the leaf
    // — critical for disambiguating identically-named sub-zones
    // across different parents (e.g. "מרתף" under building A vs B).
    const zoneNameById = new Map<number, string>();
    for (const z of flatZones) zoneNameById.set(z.id, z.name);

    // Attach loggedMinutes + zoneBreadcrumb to each task. Breadcrumb
    // walks the zone.path (a slash-separated list of zone ids from
    // root → leaf). Falls back to an empty array for tasks at the
    // project root (zone is null).
    const tasksWithLogged = tasks.map((t) => {
      const zonePath: string = (t as any).zone
        ? (flatZones.find((z) => z.id === t.zoneId)?.path ?? '')
        : '';
      const zoneBreadcrumb = zonePath
        ? zonePath
            .split('/')
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n))
            .map((id) => zoneNameById.get(id))
            .filter((n): n is string => !!n)
        : [];
      const actual = actualByTask.get(t.id);
      return {
        ...t,
        loggedMinutes: loggedByTask.get(t.id) ?? 0,
        // M5 — actual cost (logged hours x hourly cost). 0 when no
        // rateable entries exist on the task; UI renders an em-dash.
        actualCost: actual ? Number(actual.cost.toFixed(2)) : 0,
        actualCostCurrency: actual?.currency ?? null,
        zoneBreadcrumb,
      };
    });

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
