import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  type CleanupAction,
  type CleanupCandidate,
  EMPTY_USAGE,
  type PhaseRow,
  type PhaseUsage,
  planServicePhaseCleanup,
} from './qa6-service-phase-cleanup.plan';

/**
 * PR-069 (QA6, 2026-11-25) — executor behind
 * `POST /admin/backfills/qa6-service-phase-cleanup`. Rules: see
 * `qa6-service-phase-cleanup.plan.ts`.
 *
 * Safety:
 *   • DRY-RUN IS THE DEFAULT. Only `dryRun: false` writes, and then only
 *     with `approved: [{ id, action, mergeInto? }]`: the rows Yulian
 *     reviewed in the dry-run list, WITH the action (and merge target)
 *     he approved. The plan is recomputed at run time; when an approved
 *     row now plans another action or another target (data changed since
 *     the dry-run), the run is refused with 409
 *     SERVICE_PHASE_CLEANUP_PLAN_CHANGED and writes nothing (security
 *     review 25.11: an id list alone approved whatever the plan said at
 *     run time). A candidate that is not approved is left alone; an
 *     approved id that is not (or no longer) a candidate is reported and
 *     skipped. The old `approvedIds` body is refused (400).
 *   • NOTHING IS DELETED. `mark_phase` sets `kind = 'phase'`;
 *     `deactivate` sets `isActive = false`; `merge` re-points every
 *     foreign key (tasks, including deleted ones, templates, template
 *     tasks, template zone tasks, project deliverables) to the row that
 *     stays and then deactivates the duplicate. A task that pointed at a
 *     merged row shows the same service through the row that stays.
 *   • ONE TRANSACTION for the whole approved set.
 *   • IDEMPOTENT. Marked / deactivated rows are no longer candidates.
 */

/** One reviewed dry-run row: the id, the action approved for it and, for a merge, the row it merges into. */
export interface ApprovedCleanupItem {
  id: number;
  action: CleanupAction;
  /** The row that stays (`mergeInto.id` of the dry-run). Required for `merge`. */
  mergeInto: number | null;
}

export interface ServicePhaseCleanupBody {
  dryRun: boolean;
  approved?: ApprovedCleanupItem[];
}

const ACTIONS: readonly CleanupAction[] = ['mark_phase', 'merge', 'deactivate'];

const isPositiveInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

function badApproved(message: string): BadRequestException {
  return new BadRequestException({ code: 'SERVICE_PHASE_CLEANUP_BAD_APPROVED', message });
}

/**
 * Body of the endpoint, validated by hand like `parseP1CopiesToRefsBody`.
 *
 *   dryRun     Anything but the boolean `false` is a dry-run.
 *   approved   Required for a real run: a non-empty array of
 *              `{ id, action, mergeInto? }` copied from the dry-run
 *              candidates (`mergeInto` may be the id or the dry-run's
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
        'approvedIds is no longer accepted. Send approved: [{ id, action, mergeInto }] copied from the dry-run, so the run can check that the plan did not change.',
    });
  }
  const list = raw.approved;
  if (list == null) {
    if (!dryRun) {
      throw new BadRequestException({
        code: 'SERVICE_PHASE_CLEANUP_APPROVED_REQUIRED',
        message:
          'A real run needs approved: the dry-run rows that were reviewed, each { id, action, mergeInto }.',
      });
    }
    return { dryRun };
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw badApproved('approved must be a non-empty array of { id, action, mergeInto }.');
  }
  const seen = new Set<number>();
  const approved = list.map((item, i): ApprovedCleanupItem => {
    const it = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (!isPositiveInt(it.id)) throw badApproved(`approved[${i}].id must be a positive integer.`);
    if (seen.has(it.id)) throw badApproved(`approved lists #${it.id} twice.`);
    seen.add(it.id);
    if (!ACTIONS.includes(it.action as CleanupAction)) {
      throw badApproved(`approved[${i}].action must be one of ${ACTIONS.join(', ')}.`);
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
    return { id: it.id, action: it.action as CleanupAction, mergeInto: (target as number | null) ?? null };
  });
  return { dryRun, approved };
}

/** An approved row whose recomputed plan is not what was approved. */
export interface PlanMismatch {
  id: number;
  approved: { action: CleanupAction; mergeInto: number | null };
  planned: { action: CleanupAction; mergeInto: number | null };
}

/**
 * Approved rows whose recomputed candidate has another action or another
 * target. A `mergeInto` sent with a `deactivate` / `mark_phase` must
 * match too. Approved ids that are no candidate now are not mismatches
 * (they are reported as `notCandidates` and skipped).
 */
export function planMismatches(approved: readonly ApprovedCleanupItem[], candidates: readonly CleanupCandidate[]): PlanMismatch[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: PlanMismatch[] = [];
  for (const a of approved) {
    const c = byId.get(a.id);
    if (!c) continue;
    const plannedTarget = c.mergeInto?.id ?? null;
    const targetDiffers = a.action === 'merge' ? a.mergeInto !== plannedTarget : a.mergeInto != null && a.mergeInto !== plannedTarget;
    if (c.action !== a.action || targetDiffers) {
      out.push({
        id: a.id,
        approved: { action: a.action, mergeInto: a.mergeInto },
        planned: { action: c.action, mergeInto: plannedTarget },
      });
    }
  }
  return out;
}

export interface AppliedChange {
  id: number;
  action: CleanupCandidate['action'];
  mergeInto: number | null;
  repointed: {
    tasks: number;
    templates: number;
    templateTasks: number;
    templateZoneTasks: number;
    projectDeliverables: number;
  } | null;
}

export interface ServicePhaseCleanupResult {
  dryRun: boolean;
  totalRows: number;
  candidates: CleanupCandidate[];
  /** Every other row, untouched by any run. */
  unchanged: Array<{ id: number; name: string; code: string | null; kind: string; isActive: boolean }>;
  /** The approved rows of the body (normalized), null when none were sent. */
  approved: ApprovedCleanupItem[] | null;
  /** Approved ids that are not a candidate now (wrong id, or already done). */
  notCandidates: number[];
  /** Candidates left alone because they were not approved (real run). */
  notApproved: number[];
  /** null on a dry-run. */
  applied: AppliedChange[] | null;
}

const CATALOG_CODE = '__TASK_CATALOG__';

@Injectable()
export class Qa6ServicePhaseCleanupService {
  private readonly logger = new Logger('qa6-service-phase-cleanup');

  constructor(private readonly prisma: PrismaService) {}

  /** Where each `phases` row is used (see `PhaseUsage`). */
  async loadUsage(ids: number[]): Promise<Map<number, PhaseUsage>> {
    const out = new Map<number, PhaseUsage>();
    for (const id of ids) out.set(id, { ...EMPTY_USAGE });
    if (ids.length === 0) return out;

    const [tasks, templates, catalogItems, templateTasks, zoneTasks, deliverables, taskProjects, pdProjects] =
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
      ]);

    const add = (rows: any[], key: string, field: keyof PhaseUsage) => {
      for (const g of rows) {
        const u = out.get(g[key]);
        if (u) u[field] += g._count?._all ?? 0;
      }
    };
    add(tasks, 'phaseId', 'tasks');
    add(templates, 'phaseId', 'templates');
    add(catalogItems, 'phaseId', 'taskCatalogItems');
    add(templateTasks, 'phaseId', 'templateTasks');
    add(zoneTasks, 'phaseId', 'templateTasks');
    add(deliverables, 'serviceId', 'projectDeliverables');

    const projects = new Map<number, Set<number>>();
    for (const r of taskProjects as Array<{ phaseId: number; projectId: number }>) {
      projects.set(r.phaseId, (projects.get(r.phaseId) ?? new Set()).add(r.projectId));
    }
    for (const r of pdProjects as Array<{ serviceId: number; projectId: number }>) {
      projects.set(r.serviceId, (projects.get(r.serviceId) ?? new Set()).add(r.projectId));
    }
    for (const [id, set] of projects) out.get(id)!.projects = set.size;
    return out;
  }

  async run(body: ServicePhaseCleanupBody & { actorId?: number }): Promise<ServicePhaseCleanupResult> {
    const rows = (await this.prisma.phase.findMany({
      select: { id: true, name: true, code: true, kind: true, isActive: true },
      orderBy: { id: 'asc' },
    })) as PhaseRow[];
    const serviceTypes = await this.prisma.serviceType.findMany({
      select: { id: true, name: true, code: true },
    });
    const usage = await this.loadUsage(rows.map((r) => r.id));
    const { candidates, unchanged } = planServicePhaseCleanup(rows, usage, serviceTypes);

    const candidateIds = new Set(candidates.map((c) => c.id));
    const approved = body.approved ?? null;
    const approvedSet = new Set((approved ?? []).map((a) => a.id));
    const result: ServicePhaseCleanupResult = {
      dryRun: body.dryRun,
      totalRows: rows.length,
      candidates,
      unchanged: unchanged.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        kind: r.kind,
        isActive: r.isActive,
      })),
      approved,
      notCandidates: (approved ?? []).map((a) => a.id).filter((id) => !candidateIds.has(id)),
      notApproved: body.dryRun ? [] : candidates.filter((c) => !approvedSet.has(c.id)).map((c) => c.id),
      applied: null,
    };

    this.logger.log(
      `dryRun=${body.dryRun} actor=${body.actorId ?? 'system'} rows=${rows.length} ` +
        `candidates=${candidates.length} approved=${approved?.length ?? 0}`,
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

    const toApply = candidates.filter((c) => approvedSet.has(c.id));
    // Merges and deactivations first, then the phase marks, so a row that
    // is both a merge target and a phase ends up marked.
    const order = { merge: 0, deactivate: 1, mark_phase: 2 } as const;
    toApply.sort((a, b) => order[a.action] - order[b.action] || a.id - b.id);

    const applied: AppliedChange[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        for (const c of toApply) {
          if (c.action === 'mark_phase') {
            await tx.phase.update({ where: { id: c.id }, data: { kind: 'phase' } });
            applied.push({ id: c.id, action: c.action, mergeInto: null, repointed: null });
            continue;
          }
          let repointed: AppliedChange['repointed'] = null;
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
          applied.push({ id: c.id, action: c.action, mergeInto: c.mergeInto?.id ?? null, repointed });
        }
      },
      { timeout: 60_000 },
    );
    this.logger.log(`applied ${applied.length} change(s): ${applied.map((a) => `${a.action}#${a.id}`).join(', ')}`);
    return { ...result, applied };
  }
}
