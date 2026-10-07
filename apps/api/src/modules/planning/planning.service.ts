import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { withQueryTimeout } from '../../common/query-timeout';
import { extractServiceMarker, resolvePhasesByMarkerNames } from './marker-phase-resolver';

/**
 * QA5 UI-15 — identity key for the typical-rank cache. Tasks don't
 * carry a template-task FK so a normalized name is the only stable
 * handle. Lowercase + trim + collapse internal whitespace so trivial
 * differences (double space / trailing space / Hebrew niqqud spacing)
 * all collapse to the same bucket.
 */
export function taskIdentityKey(name: string | null | undefined): string {
  if (!name) return 'name:';
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return `name:${normalized}`;
}

@Injectable()
export class PlanningService {
  private readonly logger = new Logger(PlanningService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Public entry point. Wraps the actual read in a per-request query
   * timeout so a slow/stuck query returns 503 instead of stalling the
   * event loop. See ../common/query-timeout.ts for the mechanism and its
   * limits (JS-level timeout; MySQL keeps running the query in the
   * connection until it finishes on its own — acceptable first-pass
   * containment while we chase the wedge's real cause).
   */
  async getPlanningData(projectId: number) {
    return withQueryTimeout(
      () => this.getPlanningDataImpl(projectId),
      undefined,
      `getPlanningData(${projectId})`,
    );
  }

  private async getPlanningDataImpl(projectId: number) {
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
        // /templates/deliverables exactly. Includes `phase` (2026-09-29)
        // so the FE Service-column fallback can read the source template's
        // service when the project Task itself has `phaseId = NULL`
        // (historical rows created before applyProjectTemplate consistently
        // propagated the phase). Same principle as the ProjectDeliverable
        // service fallback added in commit 35125ea.
        deliverableTemplate: {
          select: {
            id: true,
            name: true,
            phase: { select: { id: true, name: true, color: true } },
          },
        },
        // First-class project-owned Deliverable — the authoritative link the
        // grid resolves its label from (overrides the catalog template name).
        // Includes `service` (2026-09-29) so the FE Service-column fallback
        // has something to read when `task.phaseId = NULL`.
        projectDeliverable: {
          select: {
            id: true,
            name: true,
            sortOrder: true,
            serviceId: true,
            service: { select: { id: true, name: true, color: true } },
          },
        },
        dependencies: { include: { dependsOn: { select: { id: true, code: true, name: true } } } },
        assignees: {
          where: { deletedAt: null },
          include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
        },
        // QA5 UI-4: expose task comment counts so the project Kanban
        // card can render the comment bubble + count on every task.
        _count: { select: { comments: true } },
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

    // ─── SERVICE resolver (server-side, marker-aware) ─────────────────
    // The planning grid's Service column needs a Phase (a "service") for
    // every task, but many project tasks materialized from legacy
    // zone-templates (e.g. "Simple building") carry NO FK to a phase or
    // deliverable-template — only the historical description marker
    // `[SERVICE:<deliverable-template-name>]`.
    //
    // We resolve that here, once per request, so the FE can just render
    // `task.service`. Priority (mirrors resolveTaskService on the FE
    // but adds a final marker→template-name JOIN):
    //   1. task.phase                                    (direct FK)
    //   2. task.projectDeliverable.service               (via included relation)
    //   3. task.deliverableTemplate.phase                (via included relation)
    //   4. description marker → Template.name JOIN → phase
    // Collect markers only for tasks with no FK-based service branch,
    // then resolve via the shared helper (kept in
    // ./marker-phase-resolver so backfills.controller can reuse it —
    // see qa4-service-marker-backfill.md).
    const markerNames = new Set<string>();
    for (const t of tasks) {
      if ((t as any).phase?.name) continue;
      if ((t as any).projectDeliverable?.service?.name) continue;
      if ((t as any).deliverableTemplate?.phase?.name) continue;
      const marker = extractServiceMarker(t.description);
      if (marker) markerNames.add(marker);
    }
    const phaseByMarkerName = await resolvePhasesByMarkerNames(this.prisma as any, markerNames);
    const resolveTaskService = (t: any): { id: number | null; name: string; color: string | null } | null => {
      if (t.phase?.name) {
        return { id: t.phase.id ?? null, name: t.phase.name, color: t.phase.color ?? null };
      }
      if (t.projectDeliverable?.service?.name) {
        const s = t.projectDeliverable.service;
        return { id: s.id ?? null, name: s.name, color: s.color ?? null };
      }
      if (t.deliverableTemplate?.phase?.name) {
        const p = t.deliverableTemplate.phase;
        return { id: p.id ?? null, name: p.name, color: p.color ?? null };
      }
      const marker = extractServiceMarker(t.description);
      if (marker) {
        const p = phaseByMarkerName.get(marker);
        if (p) return p;
      }
      return null;
    };

    // QA5 UI-15 — typical-rank lookup for the Planning tab's
    // learned-order secondary sort. One batched read of the
    // pre-computed `TaskTypicalRank` table (populated by
    // `recomputeTaskTypicalRanks` — never in a request path). We only
    // ask for the identities actually in this project's task set, so
    // this is bounded by the project size and does not scan the whole
    // table. Missing rows just produce a null `typicalRank` — the FE
    // falls back to stable sortOrder for those.
    const typicalRankLookup = await (async () => {
      const map = new Map<string, number>();
      const identities = new Set<string>();
      for (const t of tasks) {
        if (t.deliverableTemplateId == null) continue;
        identities.add(`${t.deliverableTemplateId}|${taskIdentityKey(t.name)}`);
      }
      if (identities.size === 0) return map;
      // Group identities by deliverableTemplateId so we send one
      // compact query per template rather than a huge OR chain.
      const byTemplate = new Map<number, string[]>();
      for (const key of identities) {
        const sep = key.indexOf('|');
        const tplId = Number(key.slice(0, sep));
        const identity = key.slice(sep + 1);
        if (!byTemplate.has(tplId)) byTemplate.set(tplId, []);
        byTemplate.get(tplId)!.push(identity);
      }
      // Prisma doesn't support tuple-IN on MySQL, so we fan out one
      // query per template. Template counts per project are small
      // (ten-ish at the extreme), so this stays cheap.
      await Promise.all(
        Array.from(byTemplate.entries()).map(async ([tplId, ids]) => {
          const rows = await this.prisma.taskTypicalRank.findMany({
            where: { deliverableTemplateId: tplId, taskIdentity: { in: ids } },
            select: { taskIdentity: true, medianRank: true },
          });
          for (const r of rows) {
            map.set(`${tplId}|${r.taskIdentity}`, r.medianRank);
          }
        }),
      );
      return map;
    })();

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
      // QA5 UI-4: expose a flat `commentCount` the FE card can read
      // without depending on Prisma's `_count` shape.
      const commentCount = (t as any)._count?.comments ?? 0;
      // QA5 UI-15 — the median relative rank learned from dated
      // occurrences of this (deliverableTemplate, name) across all
      // projects. Null when no history exists; the FE falls back to
      // stable sortOrder/name for those.
      const typicalRank = t.deliverableTemplateId == null
        ? null
        : typicalRankLookup.get(`${t.deliverableTemplateId}|${taskIdentityKey(t.name)}`) ?? null;
      return {
        ...t,
        loggedMinutes: loggedByTask.get(t.id) ?? 0,
        actualCost: actual ? Number(actual.cost.toFixed(2)) : 0,
        actualCostCurrency: actual?.currency ?? null,
        zoneBreadcrumb,
        deliverableTargetDate,
        // Fully resolved SERVICE (Phase) — the FE prefers this over its
        // own fallback chain because the server has the marker→template
        // JOIN available in one place. Nullable when nothing resolves.
        service: resolveTaskService(t),
        commentCount,
        typicalRank,
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

  // ─── QA5 UI-15 — TaskTypicalRank recompute ────────────────────────
  //
  // Learn the typical ordering of each task-identity inside its
  // Deliverable Template from the DATED occurrences across the whole
  // database. Idempotent, bounded, and NEVER called in a request
  // path — the admin endpoint on this controller invokes it, and the
  // Planning read-path only reads from the cached table.
  //
  // Algorithm per `(deliverableTemplateId, identity)` bucket:
  //   • For each project that has ≥1 dated task under this
  //     deliverableTemplate, compute each dated task's `relRank` =
  //     `(0-based index among the project's dated tasks for that
  //      deliverable) / (count of dated tasks in that group)`.
  //   • Collect `relRank` for every dated occurrence of the identity.
  //   • `medianRank` = median of that collection; `sampleSize` = its
  //     length.
  //
  // Ordering inside a project uses `endDate` ASC (the Due Date). Ties
  // break on `sortOrder` then `createdAt` to match what the planning
  // read-path returns.
  //
  // Timebox: the whole thing is a single-pass over dated tasks, so the
  // cost is O(N log N) where N = dated tasks across the DB. Staging
  // sits at ~hundreds; prod at ~thousands. We log a warning when it
  // takes >30s so a regression that bloats the aggregate shows up in
  // Sentry breadcrumbs.
  async recomputeTaskTypicalRanks(): Promise<{
    updatedBuckets: number;
    datedTasks: number;
    skippedNoDeliverable: number;
    tookMs: number;
  }> {
    const startedAt = Date.now();
    // Pull only the fields the aggregate needs. Dated AND linked to a
    // deliverableTemplate — undated or template-less tasks can't
    // teach us an order within a deliverable.
    const dated = await this.prisma.task.findMany({
      where: {
        endDate: { not: null },
        deliverableTemplateId: { not: null },
        deletedAt: null,
        isArchived: false,
      },
      select: {
        id: true,
        projectId: true,
        deliverableTemplateId: true,
        name: true,
        endDate: true,
        sortOrder: true,
        createdAt: true,
      },
    });

    // Also pick up the project tasks that are template-less but
    // belong to a project-owned ProjectDeliverable that itself has a
    // sourceTemplateId — resolving the deliverable template through
    // that link keeps the identity space consistent across the two
    // deliverable shapes. For simplicity + bounded scope here, we
    // skip them; UI-15's primary benefit comes from the template-
    // linked path. If/when staging has >1k template-less dated tasks
    // we add that second pass in a follow-up.

    // Group dated tasks by (project, deliverableTemplate) and compute
    // each task's relative rank within the group.
    type DatedTask = (typeof dated)[number];
    const groups = new Map<string, DatedTask[]>();
    for (const t of dated) {
      if (t.projectId == null) continue;
      const key = `${t.projectId}|${t.deliverableTemplateId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }

    // bucket = (deliverableTemplateId, identity) → list of relRanks
    const buckets = new Map<string, number[]>();
    for (const [, list] of groups) {
      // Sort by endDate ASC, then sortOrder, then createdAt — the
      // same deterministic order the planning read-path returns.
      list.sort((a, b) => {
        const ad = a.endDate ? a.endDate.getTime() : 0;
        const bd = b.endDate ? b.endDate.getTime() : 0;
        if (ad !== bd) return ad - bd;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      const n = list.length;
      if (n === 0) continue;
      // Dedupe multiple occurrences of the same identity INSIDE one
      // project (same task name under the same deliverable, used in
      // multiple zones) — otherwise a single project with 10 zones
      // would skew the median toward whatever rank that one project
      // chose. Keep the FIRST occurrence's rank per identity so each
      // project contributes one data point per identity.
      const seenIdentities = new Set<string>();
      for (let i = 0; i < n; i++) {
        const t = list[i];
        const identity = taskIdentityKey(t.name);
        if (seenIdentities.has(identity)) continue;
        seenIdentities.add(identity);
        // relRank in [0, 1). Divide by n (not n-1) so a single-task
        // group still produces a 0 (first = earliest).
        const relRank = i / n;
        const bucketKey = `${t.deliverableTemplateId}|${identity}`;
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
        buckets.get(bucketKey)!.push(relRank);
      }
    }

    // Compute median per bucket and upsert into TaskTypicalRank.
    // Serial upserts keep the write pressure gentle (and bounded to
    // one connection) — the table is small so this is fast enough.
    let updated = 0;
    for (const [bucketKey, ranks] of buckets) {
      const sep = bucketKey.indexOf('|');
      const deliverableTemplateId = Number(bucketKey.slice(0, sep));
      const identity = bucketKey.slice(sep + 1);
      const median = medianOf(ranks);
      await this.prisma.taskTypicalRank.upsert({
        where: {
          deliverableTemplateId_taskIdentity: {
            deliverableTemplateId,
            taskIdentity: identity,
          },
        },
        create: {
          deliverableTemplateId,
          taskIdentity: identity,
          medianRank: median,
          sampleSize: ranks.length,
        },
        update: {
          medianRank: median,
          sampleSize: ranks.length,
          computedAt: new Date(),
        },
      });
      updated++;
    }

    const tookMs = Date.now() - startedAt;
    if (tookMs > 30_000) {
      this.logger.warn(
        `recomputeTaskTypicalRanks took ${tookMs}ms over ${dated.length} dated tasks → ${updated} buckets`,
      );
    } else {
      this.logger.log(
        `recomputeTaskTypicalRanks: ${dated.length} dated tasks → ${updated} buckets in ${tookMs}ms`,
      );
    }

    return {
      updatedBuckets: updated,
      datedTasks: dated.length,
      skippedNoDeliverable: 0,
      tookMs,
    };
  }

  /**
   * Debug helper for the handoff report — surface the biggest
   * learned buckets so Yulian can sanity-check the aggregate without
   * SELECT-ing the table. Called by the admin probe endpoint. Joins
   * the deliverable-template name on the side (no FK relation
   * declared, by design — soft coupling only).
   */
  async listTopTypicalRanks(limit = 10) {
    const take = Math.max(1, Math.min(100, limit));
    const rows = await this.prisma.taskTypicalRank.findMany({
      orderBy: [{ sampleSize: 'desc' }, { deliverableTemplateId: 'asc' }],
      take,
    });
    const tplIds = Array.from(new Set(rows.map((r) => r.deliverableTemplateId)));
    const templates = tplIds.length === 0
      ? []
      : await this.prisma.template.findMany({
          where: { id: { in: tplIds } },
          select: { id: true, name: true },
        });
    const nameByTpl = new Map<number, string>();
    for (const t of templates) nameByTpl.set(t.id, t.name);
    return rows.map((r) => ({
      ...r,
      deliverableTemplateName: nameByTpl.get(r.deliverableTemplateId) ?? null,
    }));
  }
}

/** Median of a numeric list. Mutates in place via sort for brevity. */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}
