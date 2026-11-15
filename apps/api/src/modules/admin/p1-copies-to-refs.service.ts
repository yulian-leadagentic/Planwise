import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { buildCatalogMap } from '../zones/zones.util';
import {
  type ComposingTemplate,
  type CopyDependencyEdge,
  type DeliverableTemplate,
  type MarkerCatalogEntry,
  type PlannedSlot,
  type SkipReason,
  type SkippedGroup,
  type TemplatePlan,
  type UnresolvableRow,
  SKIP_REASONS,
  keptKeys,
  planTemplate,
  renderCurrentTree,
  renderPlannedTree,
} from './p1-copies-to-refs.plan';

/**
 * P1 · Reference model — Phase-2 EXECUTOR (work order step 5, "real
 * migration"), behind `POST /admin/backfills/p1-copies-to-refs`.
 *
 * Converts the deliverable COPIES a composing template holds into
 * reference SLOTS, one slot per `(template, parent zone or root,
 * deliverable)` group — see `p1-copies-to-refs.plan.ts` for the rules.
 * Why it matters: a project applied from a template of copies gets the
 * deliverable's tasks but none of its dependency edges (staging,
 * project 60: 26 edges expected, 2 arrived — both from the one template
 * that already used a slot).
 *
 * Safety properties:
 *   • DRY-RUN IS THE DEFAULT. Only `dryRun: false` reaches a write.
 *   • TEMPLATES ONLY. It reads and writes `Template`, `TemplateZone`,
 *     `TemplateTask`, `TemplateZoneTask` (and reads
 *     `TemplateTaskDependency`). It never touches `Task`,
 *     `TaskDependency`, `Zone` or any `Project*` row — an existing
 *     project keeps the snapshot it pulled (the spec asserts this).
 *   • ONE TRANSACTION PER TEMPLATE. A template is either fully
 *     converted or untouched. A real run stops at the first template
 *     that fails and reports the rest as not attempted.
 *   • IDEMPOTENT. A converted group is recognised by its slot
 *     (`already_linked`), so a second run plans nothing for it.
 *   • NOTHING IS LOST SILENTLY. A copy whose code the deliverable does
 *     not have is kept, and every difference between the copies and the
 *     deliverable is listed before anything is written (the drift
 *     report), in the dry-run and in the real response alike.
 */

export interface P1CopiesToRefsOptions {
  dryRun: boolean;
  /** Limit the run to these composing templates. */
  templateIds?: number[];
  actorId?: number;
}

export interface TemplateWriteResult {
  status: 'written' | 'nothing_to_write' | 'failed' | 'not_attempted';
  slotsCreated: Array<{
    zoneId: number;
    key: string;
    parentZoneId: number | null;
    deliverableTemplateId: number;
    sortOrder: number;
  }>;
  templateTasksDeleted: number;
  templateZoneTasksDeleted: number;
  error: string | null;
}

export interface TemplateReport {
  templateId: number;
  templateName: string;
  templateType: string;
  plannedSlots: PlannedSlot[];
  skippedGroups: SkippedGroup[];
  legacyUnresolvable: UnresolvableRow[];
  /** The template as stored when the run started. */
  before: string[];
  /**
   * `afterSource: 'planned'` — what the plan would leave (every dry-run,
   * and a real run that wrote nothing for this template).
   * `afterSource: 'actual'` — re-read from the database after the write.
   */
  after: string[];
  afterSource: 'planned' | 'actual';
  /** null on a dry-run. */
  written: TemplateWriteResult | null;
}

export interface P1CopiesToRefsResult {
  dryRun: boolean;
  requestedTemplateIds: number[] | null;
  /** Requested ids that are not a live composing template (missing, deleted, or a `task_list`). */
  unknownTemplateIds: number[];
  /** Composing templates looked at. */
  scannedTemplates: number;
  templates: TemplateReport[];
  totals: {
    /** Templates with at least one planned slot. */
    templates: number;
    slots: number;
    /** Copies the plan replaces — on a real run, see `written` for what was deleted. */
    copyRowsDeleted: number;
    /** Copies under a planned slot that stay (`onlyInCopy`). */
    copyRowsKept: number;
    legacyUnresolvable: number;
    skippedGroups: number;
    skippedGroupsByReason: Record<SkipReason, number>;
    drift: {
      onlyInCopy: number;
      onlyInDeliverable: number;
      changed: number;
      changedStoredOnly: number;
    };
    copyDependencyEdgesCascaded: number;
    copyDependencyEdgesNotInDeliverable: number;
    fkSourcedRows: number;
    markerResolvedRows: number;
    /** By design — no project-side table is read or written. */
    projectsTouched: 0;
  };
  /** null on a dry-run; what a real run committed. */
  written: {
    templates: number;
    slotsCreated: number;
    templateTasksDeleted: number;
    templateZoneTasksDeleted: number;
    copyRowsDeleted: number;
    failedTemplateId: number | null;
    notAttemptedTemplateIds: number[];
    projectsTouched: 0;
  } | null;
}

/**
 * Body of `POST /admin/backfills/p1-copies-to-refs`, validated by hand
 * (an inline body type gives the global ValidationPipe nothing to check).
 *
 *   dryRun       Anything but the boolean `false` is a dry-run — a
 *                missing field, `true`, `"false"`, `0`, `null`.
 *   templateIds  When present it must be a non-empty array of positive
 *                integers. A malformed filter is a 400, never "no
 *                filter": on a real run that would convert every
 *                template instead of the one that was meant.
 */
export function parseP1CopiesToRefsBody(body: unknown): { dryRun: boolean; templateIds?: number[] } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const dryRun = raw.dryRun !== false;
  if (raw.templateIds == null) return { dryRun };

  const ids = raw.templateIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    throw new BadRequestException({
      code: 'P1_COPIES_TO_REFS_BAD_TEMPLATE_IDS',
      message: 'templateIds, when given, must be a non-empty array of positive integers.',
    });
  }
  return { dryRun, templateIds: [...new Set(ids as number[])] };
}

const CATALOG_TASK_SELECT = {
  name: true,
  defaultBudgetHours: true,
  defaultBudgetAmount: true,
} satisfies Prisma.TemplateTaskSelect;

/** One shape for both copy tables — `TemplateTask` and `TemplateZoneTask` share these columns. */
const COPY_ROW_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  phaseId: true,
  serviceTypeId: true,
  deliverableTemplateId: true,
  defaultBudgetHours: true,
  defaultBudgetAmount: true,
  sortOrder: true,
  catalogTask: { select: CATALOG_TASK_SELECT },
} satisfies Prisma.TemplateTaskSelect & Prisma.TemplateZoneTaskSelect;

const COMPOSING_SELECT = {
  id: true,
  name: true,
  type: true,
  templateTasks: { select: COPY_ROW_SELECT },
  templateZones: {
    select: {
      id: true,
      name: true,
      parentId: true,
      sortOrder: true,
      linkedTaskTemplateId: true,
      templateZoneTasks: { select: COPY_ROW_SELECT },
    },
  },
} satisfies Prisma.TemplateSelect;

const DELIVERABLE_SELECT = {
  id: true,
  name: true,
  code: true,
  type: true,
  phaseId: true,
  deletedAt: true,
  templateTasks: {
    select: {
      id: true,
      code: true,
      name: true,
      phaseId: true,
      serviceTypeId: true,
      defaultBudgetHours: true,
      defaultBudgetAmount: true,
      sortOrder: true,
      catalogTask: { select: CATALOG_TASK_SELECT },
      predecessors: { select: { dependsOnTemplateTaskId: true } },
    },
  },
} satisfies Prisma.TemplateSelect;

@Injectable()
export class P1CopiesToRefsService {
  private readonly logger = new Logger(P1CopiesToRefsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async run(options: P1CopiesToRefsOptions): Promise<P1CopiesToRefsResult> {
    const dryRun = options.dryRun !== false;
    const requested = options.templateIds && options.templateIds.length > 0 ? options.templateIds : null;

    // 1. Deliverable catalog for the legacy `[SERVICE:<name>]` marker
    //    resolver. Always the WHOLE catalog — the `templateIds` filter
    //    narrows the composing templates, never the deliverables.
    const markerCatalog: MarkerCatalogEntry[] = await this.prisma.template.findMany({
      where: { deletedAt: null, type: 'task_list' },
      select: { id: true, name: true, phaseId: true },
    });

    // 2. Composing templates (the approved planner's scope: live, and
    //    anything but a `task_list`).
    const composing: ComposingTemplate[] = await this.prisma.template.findMany({
      where: {
        deletedAt: null,
        type: { not: 'task_list' },
        ...(requested ? { id: { in: requested } } : {}),
      },
      select: COMPOSING_SELECT,
      orderBy: { id: 'asc' },
    });
    const foundIds = new Set(composing.map((t) => t.id));
    const unknownTemplateIds = (requested ?? []).filter((id) => !foundIds.has(id));

    const ctx = await this.loadPlanContext(composing, markerCatalog);
    const plans = new Map<number, TemplatePlan>();
    for (const tpl of composing) plans.set(tpl.id, planTemplate(tpl, ctx));

    // 3. Reports — BEFORE and the planned AFTER, before anything is written.
    const reports: TemplateReport[] = [];
    for (const tpl of composing) {
      const plan = plans.get(tpl.id)!;
      const hasSomething =
        plan.plannedSlots.length > 0 || plan.skippedGroups.length > 0 || plan.legacyUnresolvable.length > 0;
      // A template that was asked for by id is always reported, so a
      // "nothing to do" answer (the idempotent second run) is explicit.
      if (!hasSomething && !requested) continue;
      reports.push({
        templateId: tpl.id,
        templateName: tpl.name,
        templateType: tpl.type,
        plannedSlots: plan.plannedSlots,
        skippedGroups: plan.skippedGroups,
        legacyUnresolvable: plan.legacyUnresolvable,
        before: renderCurrentTree(tpl, ctx.deliverableById),
        after: renderPlannedTree(tpl, plan, ctx.deliverableById),
        afterSource: 'planned',
        written: null,
      });
    }

    // 4. The write — one transaction per template, stop at the first failure.
    let written: P1CopiesToRefsResult['written'] = null;
    if (!dryRun) {
      written = {
        templates: 0,
        slotsCreated: 0,
        templateTasksDeleted: 0,
        templateZoneTasksDeleted: 0,
        copyRowsDeleted: 0,
        failedTemplateId: null,
        notAttemptedTemplateIds: [],
        projectsTouched: 0,
      };
      for (const report of reports) {
        const plan = plans.get(report.templateId)!;
        if (plan.plannedSlots.length === 0) {
          report.written = emptyWrite('nothing_to_write');
          continue;
        }
        if (written.failedTemplateId != null) {
          report.written = emptyWrite('not_attempted');
          written.notAttemptedTemplateIds.push(report.templateId);
          continue;
        }
        let result: TemplateWriteResult;
        try {
          result = await this.writeTemplate(plan);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          report.written = { ...emptyWrite('failed'), error: message };
          written.failedTemplateId = plan.templateId;
          this.logger.error(
            `p1-copies-to-refs · template #${plan.templateId} FAILED and was rolled back — ${message}`,
          );
          continue;
        }
        report.written = result;
        written.templates++;
        written.slotsCreated += result.slotsCreated.length;
        written.templateTasksDeleted += result.templateTasksDeleted;
        written.templateZoneTasksDeleted += result.templateZoneTasksDeleted;
        written.copyRowsDeleted += result.templateTasksDeleted + result.templateZoneTasksDeleted;
        this.logger.log(
          `p1-copies-to-refs · template #${plan.templateId} written · slots=${result.slotsCreated.length} ` +
            `templateTasksDeleted=${result.templateTasksDeleted} templateZoneTasksDeleted=${result.templateZoneTasksDeleted} ` +
            `actor=${options.actorId ?? 'system'}`,
        );

        // AFTER, re-read: what the template actually holds now. The
        // write is committed by this point — a failed re-read must not
        // turn it into a reported failure, so it only costs the
        // "actual" tree (the planned one stays in the response).
        try {
          const reloaded = await this.prisma.template.findFirst({
            where: { id: plan.templateId },
            select: COMPOSING_SELECT,
          });
          if (reloaded) {
            report.after = renderCurrentTree(reloaded, ctx.deliverableById, {
              newSlotIds: new Set(result.slotsCreated.map((s) => s.zoneId)),
              kept: keptKeys(plan),
            });
            report.afterSource = 'actual';
          }
        } catch (err) {
          this.logger.warn(
            `p1-copies-to-refs · template #${plan.templateId} was written, but re-reading it for the AFTER tree failed — ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    const result: P1CopiesToRefsResult = {
      dryRun,
      requestedTemplateIds: requested,
      unknownTemplateIds,
      scannedTemplates: composing.length,
      templates: reports,
      totals: totalsOf([...plans.values()]),
      written,
    };
    this.logger.log(
      `p1-copies-to-refs · dryRun=${dryRun} actor=${options.actorId ?? 'system'} ` +
        `scanned=${result.scannedTemplates} templates=${result.totals.templates} slots=${result.totals.slots} ` +
        `copyRowsDeleted=${result.totals.copyRowsDeleted} copyRowsKept=${result.totals.copyRowsKept} ` +
        `skippedGroups=${result.totals.skippedGroups} legacyUnresolvable=${result.totals.legacyUnresolvable}` +
        (written
          ? ` · written: templates=${written.templates} slots=${written.slotsCreated} rows=${written.copyRowsDeleted}` +
            ` failedTemplateId=${written.failedTemplateId ?? 'none'}`
          : ''),
    );
    return result;
  }

  /** Everything the plan compares against, in three reads. */
  private async loadPlanContext(
    composing: ComposingTemplate[],
    markerCatalog: MarkerCatalogEntry[],
  ): Promise<Parameters<typeof planTemplate>[1]> {
    // Deliverables the copies point at (FK), every live `task_list` (a
    // marker can resolve to any of them), and the ones existing slots
    // link — the trees list a slot's tasks. Read WITHOUT a `deletedAt`
    // filter: a soft-deleted target must be seen to be reported.
    const deliverableIds = new Set<number>(markerCatalog.map((c) => c.id));
    const rootCopyIds: number[] = [];
    for (const tpl of composing) {
      for (const tt of tpl.templateTasks) {
        if (tt.deliverableTemplateId != null) deliverableIds.add(tt.deliverableTemplateId);
        rootCopyIds.push(tt.id);
      }
      for (const tz of tpl.templateZones) {
        if (tz.linkedTaskTemplateId != null) deliverableIds.add(tz.linkedTaskTemplateId);
        for (const tzt of tz.templateZoneTasks) {
          if (tzt.deliverableTemplateId != null) deliverableIds.add(tzt.deliverableTemplateId);
        }
      }
    }
    const deliverables: DeliverableTemplate[] =
      deliverableIds.size === 0
        ? []
        : await this.prisma.template.findMany({
            where: { id: { in: [...deliverableIds] } },
            select: DELIVERABLE_SELECT,
          });

    // The Task Catalog by code — the last budget fallback apply uses
    // (`ZonesService.loadCatalogMap`), needed to say truthfully whether
    // a copy and a deliverable task end up with the same budget.
    const taskCatalog = await this.prisma.template.findFirst({
      where: { code: '__TASK_CATALOG__' },
      select: {
        templateTasks: { select: { code: true, defaultBudgetHours: true, defaultBudgetAmount: true } },
      },
    });

    // Dependency rows on root tasks of the composing templates: the
    // ones on a deleted copy cascade with it, and the report says so.
    const copyDependencyEdges: CopyDependencyEdge[] =
      rootCopyIds.length === 0
        ? []
        : await this.prisma.templateTaskDependency.findMany({
            where: {
              OR: [
                { templateTaskId: { in: rootCopyIds } },
                { dependsOnTemplateTaskId: { in: rootCopyIds } },
              ],
            },
            select: { id: true, templateTaskId: true, dependsOnTemplateTaskId: true },
          });

    return {
      markerCatalog,
      deliverableById: new Map(deliverables.map((d) => [d.id, d])),
      codeCatalog: buildCatalogMap(taskCatalog?.templateTasks ?? []),
      copyDependencyEdges,
    };
  }

  /**
   * Convert one template, atomically. Per planned group: create the
   * slot (the same row `TemplatesService.addDeliverableRef` writes),
   * then delete exactly the copies it replaces; their
   * `TemplateTaskDependency` rows go with them (FK cascade).
   *
   * The plan was computed from a read outside this transaction, so the
   * three facts a write depends on are checked again inside it — the
   * deliverable is still a live `task_list`, no slot for the pair
   * appeared meanwhile (a second request racing this one), and every
   * row to delete is still there. Any mismatch throws and the whole
   * template rolls back.
   */
  private async writeTemplate(plan: TemplatePlan): Promise<TemplateWriteResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const out: TemplateWriteResult = { ...emptyWrite('written'), slotsCreated: [] };
        for (const s of plan.plannedSlots) {
          const deliverable = await tx.template.findFirst({
            where: { id: s.deliverableTemplateId, deletedAt: null, type: 'task_list' },
            select: { id: true },
          });
          if (!deliverable) {
            throw new Error(
              `deliverable template #${s.deliverableTemplateId} is no longer a live task_list template`,
            );
          }
          const existing = await tx.templateZone.findFirst({
            where: {
              templateId: plan.templateId,
              parentId: s.parentZoneId,
              linkedTaskTemplateId: s.deliverableTemplateId,
            },
            select: { id: true },
          });
          if (existing) {
            throw new Error(
              `zone #${existing.id} already links deliverable #${s.deliverableTemplateId} at ` +
                `${s.parentZoneId == null ? 'the root' : `zone #${s.parentZoneId}`} — the plan is stale, run again`,
            );
          }

          const zone = await tx.templateZone.create({ data: s.slot, select: { id: true } });
          out.slotsCreated.push({
            zoneId: zone.id,
            key: s.key,
            parentZoneId: s.parentZoneId,
            deliverableTemplateId: s.deliverableTemplateId,
            sortOrder: s.slot.sortOrder,
          });

          const taskIds = s.replaces.templateTasks.map((r) => r.id);
          if (taskIds.length > 0) {
            const res = await tx.templateTask.deleteMany({
              where: { id: { in: taskIds }, templateId: plan.templateId },
            });
            if (res.count !== taskIds.length) {
              throw new Error(
                `expected to delete ${taskIds.length} TemplateTask copies of deliverable #${s.deliverableTemplateId}, matched ${res.count}`,
              );
            }
            out.templateTasksDeleted += res.count;
          }

          const zoneTaskIds = s.replaces.templateZoneTasks.map((r) => r.id);
          if (zoneTaskIds.length > 0) {
            if (s.parentZoneId == null) {
              throw new Error(`group ${s.key} holds TemplateZoneTask copies but has no parent zone`);
            }
            const res = await tx.templateZoneTask.deleteMany({
              where: { id: { in: zoneTaskIds }, templateZoneId: s.parentZoneId },
            });
            if (res.count !== zoneTaskIds.length) {
              throw new Error(
                `expected to delete ${zoneTaskIds.length} TemplateZoneTask copies of deliverable #${s.deliverableTemplateId}, matched ${res.count}`,
              );
            }
            out.templateZoneTasksDeleted += res.count;
          }
        }
        return out;
      },
      { timeout: 30_000 },
    );
  }
}

function emptyWrite(status: TemplateWriteResult['status']): TemplateWriteResult {
  return { status, slotsCreated: [], templateTasksDeleted: 0, templateZoneTasksDeleted: 0, error: null };
}

function totalsOf(plans: TemplatePlan[]): P1CopiesToRefsResult['totals'] {
  const skippedGroupsByReason = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
  const totals: P1CopiesToRefsResult['totals'] = {
    templates: 0,
    slots: 0,
    copyRowsDeleted: 0,
    copyRowsKept: 0,
    legacyUnresolvable: 0,
    skippedGroups: 0,
    skippedGroupsByReason,
    drift: { onlyInCopy: 0, onlyInDeliverable: 0, changed: 0, changedStoredOnly: 0 },
    copyDependencyEdgesCascaded: 0,
    copyDependencyEdgesNotInDeliverable: 0,
    fkSourcedRows: 0,
    markerResolvedRows: 0,
    projectsTouched: 0,
  };
  for (const plan of plans) {
    if (plan.plannedSlots.length > 0) totals.templates++;
    totals.legacyUnresolvable += plan.legacyUnresolvable.length;
    totals.fkSourcedRows += plan.fkSourcedRows;
    totals.markerResolvedRows += plan.markerResolvedRows;
    for (const g of plan.skippedGroups) {
      totals.skippedGroups++;
      totals.skippedGroupsByReason[g.reason]++;
    }
    for (const s of plan.plannedSlots) {
      totals.slots++;
      totals.copyRowsDeleted += s.replaces.templateTasks.length + s.replaces.templateZoneTasks.length;
      totals.copyRowsKept += s.keeps.length;
      totals.drift.onlyInCopy += s.drift.onlyInCopy.length;
      totals.drift.onlyInDeliverable += s.drift.onlyInDeliverable.length;
      totals.drift.changed += s.drift.changed.length;
      totals.drift.changedStoredOnly += s.drift.changedStoredOnly.length;
      totals.copyDependencyEdgesCascaded += s.copyDependencyEdges.cascaded;
      totals.copyDependencyEdgesNotInDeliverable += s.copyDependencyEdges.notInDeliverable.length;
    }
  }
  return totals;
}
