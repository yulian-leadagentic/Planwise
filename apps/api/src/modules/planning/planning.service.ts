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
        // First-class project-owned Deliverable — the authoritative link the
        // grid resolves its label from (overrides the catalog template name).
        projectDeliverable: { select: { id: true, name: true, sortOrder: true, serviceId: true } },
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

    // M5 — per-task actual cost using DATE-EFFECTIVE seniority.
    // Walk each entry, look up the seniority that was active for the
    // user on the entry's date (NOT the user's current level), and
    // multiply hours by that level's defaultHourlyCost. Critical for
    // mid-project promotions so hours before/after a level change bill
    // at the correct historical rate.
    const entriesForCost = taskIds.length === 0
      ? []
      : await this.prisma.timeEntry.findMany({
          where: { taskId: { in: taskIds }, deletedAt: null },
          select: {
            taskId: true,
            minutes: true,
            userId: true,
            date: true,
          },
        });

    // Pre-load every contributor's seniority history in one query so
    // the per-entry effective-level lookup is in-memory.
    const costUserIds = Array.from(new Set(entriesForCost.map((e) => e.userId)));
    const costHistories = costUserIds.length === 0 ? [] : await this.prisma.userSeniority.findMany({
      where: { userId: { in: costUserIds } },
      include: {
        seniorityLevel: { select: { defaultHourlyCost: true, currency: true } },
      },
      orderBy: { startDate: 'desc' },
    });
    const costHistoryByUser = new Map<number, typeof costHistories>();
    for (const h of costHistories) {
      if (!costHistoryByUser.has(h.userId)) costHistoryByUser.set(h.userId, []);
      costHistoryByUser.get(h.userId)!.push(h);
    }
    const effectiveLevelAt = (userId: number, date: Date) => {
      const list = costHistoryByUser.get(userId) ?? [];
      for (const row of list) {
        if (row.startDate <= date && (row.endDate === null || row.endDate >= date)) {
          return row.seniorityLevel;
        }
      }
      return null;
    };

    // Per task: total cost + the currency seen on the first rateable
    // entry. If a task has contributors in multiple currencies the
    // numeric sum still reflects what was spent (no FX conversion); the
    // single currency tag tracks the first one — UI can call out mixed
    // currencies if needed but for v1 most orgs are single-currency.
    const actualByTask = new Map<number, { cost: number; currency: string | null }>();
    for (const e of entriesForCost) {
      if (e.taskId == null) continue;
      const level = effectiveLevelAt(e.userId, e.date);
      const hc = level?.defaultHourlyCost;
      if (hc == null) continue;
      const cost = (e.minutes / 60) * Number(hc);
      const curr = level?.currency ?? null;
      const prev = actualByTask.get(e.taskId);
      if (prev) {
        prev.cost += cost;
        if (!prev.currency) prev.currency = curr;
      } else {
        actualByTask.set(e.taskId, { cost, currency: curr });
      }
    }

    // Deliverable target date lookup (Tier E #10, 2026-08-02).
    // Prefer the per-(zone × deliverable) target when the task has a
    // zoneId; otherwise fall back to the deliverable-level target.
    // Pulled here so each task in the response carries its resolved
    // deliverableTargetDate — the project tasks grid renders this
    // as the "Deliv. Date" column (replaces the removed Est. Start).
    const deliverableIds = Array.from(
      new Set(tasks.map((t) => t.projectDeliverableId).filter((v): v is number => v != null)),
    );
    const deliverableRows = deliverableIds.length === 0 ? [] : await this.prisma.projectDeliverable.findMany({
      where: { id: { in: deliverableIds } },
      select: {
        id: true,
        targetDate: true,
        zoneTargets: { select: { zoneId: true, targetDate: true } },
      },
    });
    const deliverableTargetById = new Map<number, Date | null>();
    const zoneDeliverableTargetById = new Map<string, Date | null>();
    for (const d of deliverableRows) {
      deliverableTargetById.set(d.id, d.targetDate ?? null);
      for (const zt of d.zoneTargets) {
        zoneDeliverableTargetById.set(`${d.id}:${zt.zoneId}`, zt.targetDate ?? null);
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
      // Resolve the deliverable's target date for this task —
      // per-zone first, deliverable-level fallback. Nullable — many
      // tasks in a project won't have a target set yet.
      let deliverableTargetDate: Date | null = null;
      if (t.projectDeliverableId != null) {
        if (t.zoneId != null) {
          deliverableTargetDate = zoneDeliverableTargetById.get(`${t.projectDeliverableId}:${t.zoneId}`) ?? null;
        }
        if (!deliverableTargetDate) {
          deliverableTargetDate = deliverableTargetById.get(t.projectDeliverableId) ?? null;
        }
      }
      return {
        ...t,
        loggedMinutes: loggedByTask.get(t.id) ?? 0,
        actualCost: actual ? Number(actual.cost.toFixed(2)) : 0,
        actualCostCurrency: actual?.currency ?? null,
        zoneBreadcrumb,
        deliverableTargetDate,
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
