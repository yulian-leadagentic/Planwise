import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  type AnyCleanupCandidate,
  type CleanupAction,
  type CleanupTable,
  EMPTY_SERVICE_TYPE_USAGE,
  EMPTY_USAGE,
  type PhaseRow,
  type PhaseUsage,
  planServicePhaseCleanup,
  planServiceTypeDuplicates,
  type ServiceTypeCleanupCandidate,
  type ServiceTypeRow,
  type ServiceTypeUsage,
} from './qa6-service-phase-cleanup.plan';

/**
 * PR-069 (QA6, 2026-11-25) — executor behind
 * `POST /admin/backfills/qa6-service-phase-cleanup`. Rules: see
 * `qa6-service-phase-cleanup.plan.ts`.
 *
 * Two tables, one plan (2026-11-26): the `phases` table (the app's
 * "Service" catalog) and the `service_types` table (`GET /service-types`)
 * carry the same "BIM Coordination BIM" duplicate, so one dry-run lists
 * both, every row tagged with its `table`, and one approved list (each
 * entry with its `table`) runs both in the same transaction.
 *
 * Safety:
 *   • DRY-RUN IS THE DEFAULT. Only `dryRun: false` writes, and then only
 *     with `approved: [{ table, id, action, mergeInto? }]`: the rows Yulian
 *     reviewed in the dry-run list, WITH the action (and merge target)
 *     he approved. The plan is recomputed at run time; when an approved
 *     row now plans another action or another target (data changed since
 *     the dry-run), the run is refused with 409
 *     SERVICE_PHASE_CLEANUP_PLAN_CHANGED and writes nothing (security
 *     review 25.11: an id list alone approved whatever the plan said at
 *     run time). A candidate that is not approved is left alone; an
 *     approved row that is not (or no longer) a candidate is reported and
 *     skipped. The old `approvedIds` body is refused (400). An approved
 *     entry without `table` is a `phases` row (the body before 26.11).
 *   • NOTHING IS DELETED from either catalog. `mark_phase` sets
 *     `kind = 'phase'`; `deactivate` sets `isActive = false`; `merge`
 *     re-points every reference to the row that stays and then
 *     deactivates the duplicate:
 *       phases:        tasks (including deleted ones), templates,
 *                      template tasks, template zone tasks, project
 *                      deliverables;
 *       service_types: tasks (including deleted ones), template tasks,
 *                      template zone tasks, zone links
 *                      (`zone_service_types`), project categories
 *                      (`project_categories`). Those two link tables allow
 *                      one link per zone / project and service type: a
 *                      link the row that stays already has is removed
 *                      instead of moved (it holds nothing else), and the
 *                      dry-run shows how many (`linksAlreadyOnKeeper`).
 *     A task that pointed at a merged row shows the same service through
 *     the row that stays. Merge vs deactivate counts soft-deleted
 *     references too (review 2): a duplicate only deleted rows point at
 *     is merged, so a restored row never points at an inactive one. The
 *     dry-run usage lists those apart (`deletedTasks`, `deletedTemplates`,
 *     `deletedProjectDeliverables`; `deletedTasks` for service types).
 *   • ONE TRANSACTION for the whole approved set, both tables.
 *   • IDEMPOTENT. Marked / deactivated rows are no longer candidates.
 */

/** One reviewed dry-run row: its table, its id, the action approved for it and, for a merge, the row it merges into. */
export interface ApprovedCleanupItem {
  table: CleanupTable;
  id: number;
  action: CleanupAction;
  /** The row that stays (`mergeInto.id` of the dry-run). Required for `merge`. */
  mergeInto: number | null;
}

export interface ServicePhaseCleanupBody {
  dryRun: boolean;
  approved?: ApprovedCleanupItem[];
}

const TABLES: readonly CleanupTable[] = ['phases', 'service_types'];
const ACTIONS: Record<CleanupTable, readonly CleanupAction[]> = {
  phases: ['mark_phase', 'merge', 'deactivate'],
  service_types: ['merge', 'deactivate'],
};

const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

function badApproved(message: string): BadRequestException {
  return new BadRequestException({ code: 'SERVICE_PHASE_CLEANUP_BAD_APPROVED', message });
}

/**
 * Body of the endpoint, validated by hand like `parseP1CopiesToRefsBody`.
 *
 *   dryRun     Anything but the boolean `false` is a dry-run.
 *   approved   Required for a real run: a non-empty array of
 *              `{ table?, id, action, mergeInto? }` copied from the dry-run
 *              candidates (`table` is `phases` (the default) or
 *              `service_types`; `mergeInto` may be the id or the dry-run's
 *              `{ id, ... }` object; required for `merge`). Without it a
 *              real run is a 400, so it can never act on rows nobody
 *              reviewed. Accepted on a dry-run too: the same plan check
 *              runs, so a dry-run tells whether the real run would pass.
 *   approvedIds  Retired (400): ids alone cannot tell that the plan
 *              changed between the review and the run.
 */
export function parseServicePhaseCleanupBody(body: unknown): ServicePhaseCleanupBody {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const dryRun = raw.dryRun !== false;
  if (raw.approvedIds !== undefined) {
    throw new BadRequestException({
      code: 'SERVICE_PHASE_CLEANUP_APPROVED_IDS_RETIRED',
      message:
        'approvedIds is no longer accepted. Send approved: [{ table, id, action, mergeInto }] copied from the dry-run, so the run can check that the plan did not change.',
    });
  }
  const list = raw.approved;
  if (list == null) {
    if (!dryRun) {
      throw new BadRequestException({
        code: 'SERVICE_PHASE_CLEANUP_APPROVED_REQUIRED',
        message:
          'A real run needs approved: the dry-run rows that were reviewed, each { table, id, action, mergeInto }.',
      });
    }
    return { dryRun };
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw badApproved('approved must be a non-empty array of { table, id, action, mergeInto }.');
  }
  const seen = new Set<string>();
  const approved = list.map((item, i): ApprovedCleanupItem => {
    const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const table = (it.table ?? 'phases') as CleanupTable;
    if (!TABLES.includes(table)) {
      throw badApproved(`approved[${i}].table must be one of ${TABLES.join(', ')}.`);
    }
    if (!isPositiveInt(it.id)) throw badApproved(`approved[${i}].id must be a positive integer.`);
    if (seen.has(`${table}:${it.id}`)) throw badApproved(`approved lists ${table} #${it.id} twice.`);
    seen.add(`${table}:${it.id}`);
    if (!ACTIONS[table].includes(it.action as CleanupAction)) {
      throw badApproved(`approved[${i}].action must be one of ${ACTIONS[table].join(', ')} for a ${table} row.`);
    }
    const rawTarget = it.mergeInto;
    const target =
      rawTarget == null
        ? null
        : typeof rawTarget === 'object'
          ? (rawTarget as Record<string, unknown>).id
          : rawTarget;
    if (target != null && !isPositiveInt(target)) {
      throw badApproved(`approved[${i}].mergeInto must be a row id.`);
    }
    if (it.action === 'merge' && target == null) {
      throw badApproved(`approved[${i}] is a merge: mergeInto (the row that stays) is required.`);
    }
    return { table, id: it.id, action: it.action as CleanupAction, mergeInto: (target as number | null) ?? null };
  });
  return { dryRun, approved };
}

/** A row of one of the two tables. */
export interface CleanupRowRef {
  table: CleanupTable;
  id: number;
}

const rowKey = (r: CleanupRowRef) => `${r.table}:${r.id}`;

/** An approved row whose recomputed plan is not what was approved. */
export interface PlanMismatch {
  table: CleanupTable;
  id: number;
  approved: { action: CleanupAction; mergeInto: number | null };
  planned: { action: CleanupAction; mergeInto: number | null };
}

/**
 * Approved rows whose recomputed candidate (same table, same id) has
 * another action or another target. A `mergeInto` sent with a
 * `deactivate` / `mark_phase` must match too. Approved rows that are no
 * candidate now are not mismatches (they are reported as `notCandidates`
 * and skipped).
 */
export function planMismatches(
  approved: readonly ApprovedCleanupItem[],
  candidates: readonly AnyCleanupCandidate[],
): PlanMismatch[] {
  const byKey = new Map(candidates.map((c) => [rowKey(c), c]));
  const out: PlanMismatch[] = [];
  for (const a of approved) {
    const c = byKey.get(rowKey(a));
    if (!c) continue;
    const plannedTarget = c.mergeInto?.id ?? null;
    const targetDiffers = a.action === 'merge' ? a.mergeInto !== plannedTarget : a.mergeInto != null && a.mergeInto !== plannedTarget;
    if (c.action !== a.action || targetDiffers) {
      out.push({
        table: a.table,
        id: a.id,
        approved: { action: a.action, mergeInto: a.mergeInto },
        planned: { action: c.action, mergeInto: plannedTarget },
      });
    }
  }
  return out;
}

export interface PhaseRepointed {
  tasks: number;
  templates: number;
  templateTasks: number;
  templateZoneTasks: number;
  projectDeliverables: number;
}

export interface ServiceTypeRepointed {
  tasks: number;
  templateTasks: number;
  templateZoneTasks: number;
  /** Zone links moved to the row that stays. */
  zoneLinks: number;
  /** Zone links removed because the row that stays already had a link to that zone. */
  zoneLinksAlreadyOnKeeper: number;
  /** Project category links moved to the row that stays. */
  projectCategories: number;
  /** Project category links removed because the row that stays already had that project. */
  projectCategoriesAlreadyOnKeeper: number;
}

export type AppliedChange =
  | { table: 'phases'; id: number; action: CleanupAction; mergeInto: number | null; repointed: PhaseRepointed | null }
  | {
      table: 'service_types';
      id: number;
      action: ServiceTypeCleanupCandidate['action'];
      mergeInto: number | null;
      repointed: ServiceTypeRepointed | null;
    };

export type UnchangedRow =
  | { table: 'phases'; id: number; name: string; code: string | null; kind: string; isActive: boolean; usage: PhaseUsage }
  | { table: 'service_types'; id: number; name: string; code: string | null; isActive: boolean; usage: ServiceTypeUsage };

export interface ServicePhaseCleanupResult {
  dryRun: boolean;
  /** Rows of both tables. */
  totalRows: number;
  rowsByTable: Record<CleanupTable, number>;
  /** `phases` candidates first, then `service_types`, each by id. */
  candidates: AnyCleanupCandidate[];
  /** Every other row, untouched by any run, with the same usage counts as a candidate. */
  unchanged: UnchangedRow[];
  /** The approved rows of the body (normalized), null when none were sent. */
  approved: ApprovedCleanupItem[] | null;
  /** Approved rows that are not a candidate now (wrong id, or already done). */
  notCandidates: CleanupRowRef[];
  /** Candidates left alone because they were not approved (real run). */
  notApproved: CleanupRowRef[];
  /** null on a dry-run. */
  applied: AppliedChange[] | null;
}

const CATALOG_CODE = '__TASK_CATALOG__';

type GroupCount = { _count?: { _all?: number } } & Record<string, any>;

function addCounts<U extends object>(out: Map<number, U>, rows: GroupCount[], key: string, field: keyof U & string) {
  for (const g of rows) {
    const u = out.get(g[key]) as Record<string, number> | undefined;
    if (u) u[field] += g._count?._all ?? 0;
  }
}

function countProjects(pairs: Array<{ id: number | null; projectId: number | null }>): Map<number, number> {
  const sets = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (p.id == null || p.projectId == null) continue;
    sets.set(p.id, (sets.get(p.id) ?? new Set()).add(p.projectId));
  }
  return new Map([...sets].map(([id, set]) => [id, set.size]));
}

@Injectable()
export class Qa6ServicePhaseCleanupService {
  private readonly logger = new Logger('qa6-service-phase-cleanup');

  constructor(private readonly prisma: PrismaService) {}

  /** Where each `phases` row is used (see `PhaseUsage`). */
  async loadUsage(ids: number[]): Promise<Map<number, PhaseUsage>> {
    const out = new Map<number, PhaseUsage>();
    for (const id of ids) out.set(id, { ...EMPTY_USAGE });
    if (ids.length === 0) return out;

    const [
      tasks,
      templates,
      catalogItems,
      templateTasks,
      zoneTasks,
      deliverables,
      taskProjects,
      pdProjects,
      deletedTasks,
      deletedTemplates,
      deletedDeliverables,
    ] =
      await Promise.all([
        this.prisma.task.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.template.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids }, deletedAt: null, code: { not: CATALOG_CODE } },
          _count: { _all: true },
        }),
        this.prisma.templateTask.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids }, template: { code: CATALOG_CODE } },
          _count: { _all: true },
        }),
        this.prisma.templateTask.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids }, template: { code: { not: CATALOG_CODE } } },
          _count: { _all: true },
        }),
        this.prisma.templateZoneTask.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.projectDeliverable.groupBy({
          by: ['serviceId'],
          where: { serviceId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.task.findMany({
          where: { phaseId: { in: ids }, deletedAt: null, projectId: { not: null } },
          select: { phaseId: true, projectId: true },
          distinct: ['phaseId', 'projectId'],
        }),
        this.prisma.projectDeliverable.findMany({
          where: { serviceId: { in: ids }, deletedAt: null },
          select: { serviceId: true, projectId: true },
          distinct: ['serviceId', 'projectId'],
        }),
        // Review 2 — soft-deleted references: a merge re-points them as
        // well, so any one of them makes a duplicate a merge, not a bare
        // deactivate. (groupBy is not narrowed by the soft-delete middleware.)
        this.prisma.task.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids }, deletedAt: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.template.groupBy({
          by: ['phaseId'],
          where: { phaseId: { in: ids }, deletedAt: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.projectDeliverable.groupBy({
          by: ['serviceId'],
          where: { serviceId: { in: ids }, deletedAt: { not: null } },
          _count: { _all: true },
        }),
      ]);

    addCounts(out, tasks as GroupCount[], 'phaseId', 'tasks');
    addCounts(out, deletedTasks as GroupCount[], 'phaseId', 'deletedTasks');
    addCounts(out, deletedTemplates as GroupCount[], 'phaseId', 'deletedTemplates');
    addCounts(out, deletedDeliverables as GroupCount[], 'serviceId', 'deletedProjectDeliverables');
    addCounts(out, templates as GroupCount[], 'phaseId', 'templates');
    addCounts(out, catalogItems as GroupCount[], 'phaseId', 'taskCatalogItems');
    addCounts(out, templateTasks as GroupCount[], 'phaseId', 'templateTasks');
    addCounts(out, zoneTasks as GroupCount[], 'phaseId', 'templateTasks');
    addCounts(out, deliverables as GroupCount[], 'serviceId', 'projectDeliverables');
    const projects = countProjects([
      ...(taskProjects as Array<{ phaseId: number | null; projectId: number | null }>).map((r) => ({ id: r.phaseId, projectId: r.projectId })),
      ...(pdProjects as Array<{ serviceId: number | null; projectId: number }>).map((r) => ({ id: r.serviceId, projectId: r.projectId })),
    ]);
    for (const [id, n] of projects) out.get(id)!.projects = n;
    return out;
  }

  /** Where each `service_types` row is used (see `ServiceTypeUsage`). */
  async loadServiceTypeUsage(ids: number[]): Promise<Map<number, ServiceTypeUsage>> {
    const out = new Map<number, ServiceTypeUsage>();
    for (const id of ids) out.set(id, { ...EMPTY_SERVICE_TYPE_USAGE });
    if (ids.length === 0) return out;

    const [tasks, catalogItems, templateTasks, zoneTasks, zoneLinks, categories, taskProjects, categoryProjects, deletedTasks] =
      await Promise.all([
        this.prisma.task.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.templateTask.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids }, template: { code: CATALOG_CODE } },
          _count: { _all: true },
        }),
        this.prisma.templateTask.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids }, template: { code: { not: CATALOG_CODE } } },
          _count: { _all: true },
        }),
        this.prisma.templateZoneTask.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.zoneServiceType.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.projectCategory.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.task.findMany({
          where: { serviceTypeId: { in: ids }, deletedAt: null, projectId: { not: null } },
          select: { serviceTypeId: true, projectId: true },
          distinct: ['serviceTypeId', 'projectId'],
        }),
        this.prisma.projectCategory.findMany({
          where: { serviceTypeId: { in: ids } },
          select: { serviceTypeId: true, projectId: true },
        }),
        // Review 2 — soft-deleted tasks, re-pointed by a merge too.
        this.prisma.task.groupBy({
          by: ['serviceTypeId'],
          where: { serviceTypeId: { in: ids }, deletedAt: { not: null } },
          _count: { _all: true },
        }),
      ]);

    addCounts(out, tasks as GroupCount[], 'serviceTypeId', 'tasks');
    addCounts(out, deletedTasks as GroupCount[], 'serviceTypeId', 'deletedTasks');
    addCounts(out, catalogItems as GroupCount[], 'serviceTypeId', 'taskCatalogItems');
    addCounts(out, templateTasks as GroupCount[], 'serviceTypeId', 'templateTasks');
    addCounts(out, zoneTasks as GroupCount[], 'serviceTypeId', 'templateTasks');
    addCounts(out, zoneLinks as GroupCount[], 'serviceTypeId', 'zoneLinks');
    addCounts(out, categories as GroupCount[], 'serviceTypeId', 'projectCategories');
    const projects = countProjects([
      ...(taskProjects as Array<{ serviceTypeId: number | null; projectId: number | null }>).map((r) => ({
        id: r.serviceTypeId,
        projectId: r.projectId,
      })),
      ...(categoryProjects as Array<{ serviceTypeId: number; projectId: number }>).map((r) => ({
        id: r.serviceTypeId,
        projectId: r.projectId,
      })),
    ]);
    for (const [id, n] of projects) out.get(id)!.projects = n;
    return out;
  }

  /**
   * For every `service_types` merge: how many of the duplicate's zone
   * links / project categories the row that stays already has (the merge
   * removes those instead of moving them).
   */
  private async fillLinksAlreadyOnKeeper(candidates: ServiceTypeCleanupCandidate[]): Promise<void> {
    const merges = candidates.filter((c) => c.action === 'merge');
    if (merges.length === 0) return;
    const ids = [...new Set(merges.flatMap((c) => [c.id, c.mergeInto.id]))];
    const [zoneLinks, categories] = await Promise.all([
      this.prisma.zoneServiceType.findMany({
        where: { serviceTypeId: { in: ids } },
        select: { zoneId: true, serviceTypeId: true },
      }),
      this.prisma.projectCategory.findMany({
        where: { serviceTypeId: { in: ids } },
        select: { projectId: true, serviceTypeId: true },
      }),
    ]);
    type Link = { owner: number; serviceTypeId: number };
    const zones: Link[] = zoneLinks.map((z) => ({ owner: z.zoneId, serviceTypeId: z.serviceTypeId }));
    const projects: Link[] = categories.map((p) => ({ owner: p.projectId, serviceTypeId: p.serviceTypeId }));
    const owners = (links: Link[], stId: number) =>
      new Set(links.filter((l) => l.serviceTypeId === stId).map((l) => l.owner));
    const overlap = (links: Link[], c: ServiceTypeCleanupCandidate) => {
      const keep = owners(links, c.mergeInto.id);
      return [...owners(links, c.id)].filter((o) => keep.has(o)).length;
    };
    for (const c of merges) {
      c.linksAlreadyOnKeeper = { zoneLinks: overlap(zones, c), projectCategories: overlap(projects, c) };
    }
  }

  async run(body: ServicePhaseCleanupBody & { actorId?: number }): Promise<ServicePhaseCleanupResult> {
    const rows = (await this.prisma.phase.findMany({
      select: { id: true, name: true, code: true, kind: true, isActive: true },
      orderBy: { id: 'asc' },
    })) as PhaseRow[];
    const serviceTypes = (await this.prisma.serviceType.findMany({
      select: { id: true, name: true, code: true, isActive: true },
      orderBy: { id: 'asc' },
    })) as ServiceTypeRow[];
    const usage = await this.loadUsage(rows.map((r) => r.id));
    const stUsage = await this.loadServiceTypeUsage(serviceTypes.map((r) => r.id));
    const phasePlan = planServicePhaseCleanup(
      rows,
      usage,
      serviceTypes.filter((st) => st.isActive !== false),
    );
    const stPlan = planServiceTypeDuplicates(serviceTypes, stUsage);
    await this.fillLinksAlreadyOnKeeper(stPlan.candidates);
    const candidates: AnyCleanupCandidate[] = [...phasePlan.candidates, ...stPlan.candidates];

    const candidateKeys = new Set(candidates.map(rowKey));
    const approved = body.approved ?? null;
    const approvedKeys = new Set((approved ?? []).map(rowKey));
    const ref = (r: CleanupRowRef): CleanupRowRef => ({ table: r.table, id: r.id });
    const result: ServicePhaseCleanupResult = {
      dryRun: body.dryRun,
      totalRows: rows.length + serviceTypes.length,
      rowsByTable: { phases: rows.length, service_types: serviceTypes.length },
      candidates,
      unchanged: [
        ...phasePlan.unchanged.map(
          (r): UnchangedRow => ({
            table: 'phases',
            id: r.id,
            name: r.name,
            code: r.code ?? null,
            kind: r.kind,
            isActive: r.isActive,
            usage: usage.get(r.id) ?? { ...EMPTY_USAGE },
          }),
        ),
        ...stPlan.unchanged.map(
          (r): UnchangedRow => ({
            table: 'service_types',
            id: r.id,
            name: r.name,
            code: r.code ?? null,
            isActive: r.isActive !== false,
            usage: stUsage.get(r.id) ?? { ...EMPTY_SERVICE_TYPE_USAGE },
          }),
        ),
      ],
      approved,
      notCandidates: (approved ?? []).filter((a) => !candidateKeys.has(rowKey(a))).map(ref),
      notApproved: body.dryRun ? [] : candidates.filter((c) => !approvedKeys.has(rowKey(c))).map(ref),
      applied: null,
    };

    this.logger.log(
      `dryRun=${body.dryRun} actor=${body.actorId ?? 'system'} phases=${rows.length} serviceTypes=${serviceTypes.length} ` +
        `candidates=${phasePlan.candidates.length}+${stPlan.candidates.length} approved=${approved?.length ?? 0}`,
    );
    // The plan is recomputed now: every approved row must still plan the
    // action and target that were approved, else nothing is written.
    const mismatches = planMismatches(approved ?? [], candidates);
    if (mismatches.length > 0) {
      throw new ConflictException({
        code: 'SERVICE_PHASE_CLEANUP_PLAN_CHANGED',
        message:
          'The cleanup plan changed since the dry-run for some approved rows, so nothing was written. Run the dry-run again, review it and approve the new list.',
        details: { mismatches },
      });
    }
    if (body.dryRun) return result;

    // Merges and deactivations first, then the phase marks, so a row that
    // is both a merge target and a phase ends up marked. `phases` rows
    // first, then `service_types` rows.
    const order = { merge: 0, deactivate: 1, mark_phase: 2 } as const;
    const phaseApply = phasePlan.candidates
      .filter((c) => approvedKeys.has(rowKey(c)))
      .sort((a, b) => order[a.action] - order[b.action] || a.id - b.id);
    const stApply = stPlan.candidates
      .filter((c) => approvedKeys.has(rowKey(c)))
      .sort((a, b) => order[a.action] - order[b.action] || a.id - b.id);

    const applied: AppliedChange[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        for (const c of phaseApply) {
          if (c.action === 'mark_phase') {
            await tx.phase.update({ where: { id: c.id }, data: { kind: 'phase' } });
            applied.push({ table: 'phases', id: c.id, action: c.action, mergeInto: null, repointed: null });
            continue;
          }
          let repointed: PhaseRepointed | null = null;
          if (c.action === 'merge' && c.mergeInto) {
            const to = c.mergeInto.id;
            const [t, tpl, tt, tzt, pd] = [
              await tx.task.updateMany({ where: { phaseId: c.id }, data: { phaseId: to } }),
              await tx.template.updateMany({ where: { phaseId: c.id }, data: { phaseId: to } }),
              await tx.templateTask.updateMany({ where: { phaseId: c.id }, data: { phaseId: to } }),
              await tx.templateZoneTask.updateMany({ where: { phaseId: c.id }, data: { phaseId: to } }),
              await tx.projectDeliverable.updateMany({ where: { serviceId: c.id }, data: { serviceId: to } }),
            ];
            repointed = {
              tasks: t.count,
              templates: tpl.count,
              templateTasks: tt.count,
              templateZoneTasks: tzt.count,
              projectDeliverables: pd.count,
            };
          }
          await tx.phase.update({ where: { id: c.id }, data: { isActive: false } });
          applied.push({ table: 'phases', id: c.id, action: c.action, mergeInto: c.mergeInto?.id ?? null, repointed });
        }

        for (const c of stApply) {
          let repointed: ServiceTypeRepointed | null = null;
          if (c.action === 'merge') {
            const from = c.id;
            const to = c.mergeInto.id;
            const t = await tx.task.updateMany({ where: { serviceTypeId: from }, data: { serviceTypeId: to } });
            const tt = await tx.templateTask.updateMany({ where: { serviceTypeId: from }, data: { serviceTypeId: to } });
            const tzt = await tx.templateZoneTask.updateMany({
              where: { serviceTypeId: from },
              data: { serviceTypeId: to },
            });
            // One link per (zone, service type) and per (project, service
            // type): move the links the row that stays does not have yet,
            // then remove the rest (the row that stays already has them).
            const keeperZones = (
              await tx.zoneServiceType.findMany({ where: { serviceTypeId: to }, select: { zoneId: true } })
            ).map((z) => z.zoneId);
            const zMoved = await tx.zoneServiceType.updateMany({
              where: { serviceTypeId: from, zoneId: { notIn: keeperZones } },
              data: { serviceTypeId: to },
            });
            const zDropped = await tx.zoneServiceType.deleteMany({ where: { serviceTypeId: from } });
            const keeperProjects = (
              await tx.projectCategory.findMany({ where: { serviceTypeId: to }, select: { projectId: true } })
            ).map((p) => p.projectId);
            const pMoved = await tx.projectCategory.updateMany({
              where: { serviceTypeId: from, projectId: { notIn: keeperProjects } },
              data: { serviceTypeId: to },
            });
            const pDropped = await tx.projectCategory.deleteMany({ where: { serviceTypeId: from } });
            repointed = {
              tasks: t.count,
              templateTasks: tt.count,
              templateZoneTasks: tzt.count,
              zoneLinks: zMoved.count,
              zoneLinksAlreadyOnKeeper: zDropped.count,
              projectCategories: pMoved.count,
              projectCategoriesAlreadyOnKeeper: pDropped.count,
            };
          }
          await tx.serviceType.update({ where: { id: c.id }, data: { isActive: false } });
          applied.push({ table: 'service_types', id: c.id, action: c.action, mergeInto: c.mergeInto.id, repointed });
        }
      },
      { timeout: 60_000 },
    );
    this.logger.log(
      `applied ${applied.length} change(s): ${applied.map((a) => `${a.table}:${a.action}#${a.id}`).join(', ')}`,
    );
    return { ...result, applied };
  }
}
