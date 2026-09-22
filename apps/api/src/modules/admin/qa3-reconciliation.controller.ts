/**
 * TEMPORARY atomic reconciliation endpoint for QA3 Wave-1 Commit 3B.
 *
 * See docs/bm2/qa3-commit3.md §3B. Runs the whole
 * project_types / service_types split as ONE Prisma $transaction so the
 * safety guarantees the spec asks for — atomic, reversible (via
 * dryRun), reports counts, staging only — are enforced by shape, not
 * by convention.
 *
 *   POST /api/v1/admin/qa3-3b-reconciliation { "dryRun": true }
 *
 * Behaviour:
 *   1. `create`: for each of {מגורים, מסחר, מלונאות, חינוך, בטחוני,
 *      Infrastructure}, INSERT into project_types iff a row with that
 *      exact name doesn't already exist. Idempotent by name.
 *   2. `delete`: for each id in {5, 9, 10, 11, 15, 16} on service_types
 *      (rows the plan wants moved), inside the same tx count how many
 *      tasks and zone_service_types junction rows reference it — DELETE
 *      only when BOTH are 0. Otherwise skip and report the count. Rows
 *      that would create a duplicate on the moved side are not
 *      re-created; they're only removed from service_types when both
 *      FK counts allow it.
 *   3. dryRun: when true the tx throws at the end so Prisma rolls back
 *      everything. The response still returns the actions the tx WOULD
 *      have taken (captured before the throw) so you can diff on paper.
 *   4. NEVER runs on production. If NODE_ENV === 'production' the
 *      endpoint 403s immediately.
 *
 * Removed at Wave-1 close alongside the qa3-integrity endpoint. Reversal
 * is one commit — this file + the admin.module.ts registration.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

// Rows to migrate from service_types → project_types. Idempotent by
// name — an existing row on project_types short-circuits the insert.
const CATEGORIES_TO_CREATE = [
  'מגורים',
  'מסחר',
  'מלונאות',
  'חינוך',
  'בטחוני',
  'Infrastructure',
];

// Candidate service_type ids to remove. Row 11 (למחוק) is a test row.
// Row 8 (מלונאות) has 1 task in the previous audit and is DELIBERATELY
// NOT in this list — leaving it alone until Yulian decides how to
// reassign that task. Row 14 (BIM Coordination BIM) is a merge target,
// not a plain delete, and is also excluded.
const SERVICE_TYPE_DELETE_CANDIDATES = [5, 9, 10, 11, 15, 16];

// Sentinel thrown to force a $transaction rollback for the dry-run path.
// Anything thrown works, but a named class keeps the intent clear when
// reading the catch below.
class DryRunRollback extends Error {
  constructor(public readonly payload: unknown) {
    super('QA3-3B dry-run — transaction rolled back on purpose');
  }
}

type CreateAction =
  | { name: string; action: 'CREATED'; newId: number }
  | { name: string; action: 'SKIPPED_EXISTS'; existingId: number };

type DeleteAction =
  | { id: number; name: string | null; action: 'DELETED' }
  | {
      id: number;
      name: string | null;
      action: 'SKIPPED_FK';
      taskRefs: number;
      zoneServiceTypeRefs: number;
    };

interface ReconciliationResponse {
  dryRun: boolean;
  ranAt: string;
  nodeEnv: string | undefined;
  before: {
    projectTypes: Array<{ id: number; name: string; code: string | null }>;
    serviceTypes: Array<{ id: number; name: string; code: string | null }>;
  };
  actions: {
    creates: CreateAction[];
    deletes: DeleteAction[];
  };
  after: {
    projectTypes: Array<{ id: number; name: string; code: string | null }>;
    serviceTypes: Array<{ id: number; name: string; code: string | null }>;
  };
}

@ApiTags('Admin - QA3 3B reconciliation (TEMP)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/qa3-3b-reconciliation')
export class Qa3ReconciliationController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Atomically apply the 3B project/service split (idempotent, FK-gated, dryRun-reversible, staging only). TEMPORARY.',
  })
  async run(
    @Body() body: { dryRun?: boolean } = {},
  ): Promise<ReconciliationResponse> {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'qa3-3b-reconciliation is staging-only. NODE_ENV=production refuses to run.',
      );
    }

    const dryRun = body?.dryRun === true;
    const ranAt = new Date().toISOString();

    try {
      const payload = await this.prisma.$transaction(async (tx) => {
        // Snapshot BEFORE state — captured inside the tx so the report
        // reflects the exact rows the migration acted on.
        const before = {
          projectTypes: await tx.projectType.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { id: 'asc' },
          }),
          serviceTypes: await tx.serviceType.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { id: 'asc' },
          }),
        };

        // CREATE — idempotent by name.
        const existingNames = new Set(before.projectTypes.map((r) => r.name));
        const creates: CreateAction[] = [];
        for (const name of CATEGORIES_TO_CREATE) {
          const existing = before.projectTypes.find((r) => r.name === name);
          if (existing) {
            creates.push({
              name,
              action: 'SKIPPED_EXISTS',
              existingId: existing.id,
            });
            continue;
          }
          if (existingNames.has(name)) {
            continue; // shouldn't happen; guard for the linter
          }
          const created = await tx.projectType.create({
            data: { name },
            select: { id: true },
          });
          creates.push({ name, action: 'CREATED', newId: created.id });
          existingNames.add(name);
        }

        // DELETE — inside-tx FK gate. Counts both Task.serviceTypeId and
        // ZoneServiceType.serviceTypeId (junction). Skip on any non-zero.
        const deletes: DeleteAction[] = [];
        for (const id of SERVICE_TYPE_DELETE_CANDIDATES) {
          const row = before.serviceTypes.find((r) => r.id === id);
          const [taskRefs, zoneServiceTypeRefs] = await Promise.all([
            tx.task.count({
              where: { serviceTypeId: id, deletedAt: null },
            }),
            tx.zoneServiceType.count({
              where: { serviceTypeId: id },
            }),
          ]);
          if (taskRefs === 0 && zoneServiceTypeRefs === 0) {
            await tx.serviceType.delete({ where: { id } });
            deletes.push({
              id,
              name: row?.name ?? null,
              action: 'DELETED',
            });
          } else {
            deletes.push({
              id,
              name: row?.name ?? null,
              action: 'SKIPPED_FK',
              taskRefs,
              zoneServiceTypeRefs,
            });
          }
        }

        // Snapshot AFTER state inside the tx so the report is a true
        // preview of what would have happened.
        const after = {
          projectTypes: await tx.projectType.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { id: 'asc' },
          }),
          serviceTypes: await tx.serviceType.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { id: 'asc' },
          }),
        };

        const result: ReconciliationResponse = {
          dryRun,
          ranAt,
          nodeEnv: process.env.NODE_ENV,
          before,
          actions: { creates, deletes },
          after,
        };

        if (dryRun) {
          // Throwing rolls back the WHOLE transaction. We attach the
          // built payload to the error so the response is still populated
          // outside — nothing is written to the DB.
          throw new DryRunRollback(result);
        }

        return result;
      });

      return payload;
    } catch (err) {
      if (err instanceof DryRunRollback) {
        return err.payload as ReconciliationResponse;
      }
      throw err;
    }
  }

  /**
   * Wave-1 close tail cleanup: merge service_type 14 ("BIM Coordination
   * BIM", the misspelled duplicate) into service_type 13 ("BIM
   * Coordination"). Repoints every task's serviceTypeId 14→13, moves
   * the ZoneServiceType junction rows (with idempotent skip when the
   * (zone,13) pair already exists), then DELETEs 14 iff its remaining
   * FK count is zero.
   *
   * Also audits the 1 remaining Task on service_type 8 ("מלונאות") so
   * Yulian can pick its correct service later — that row is left in
   * place per user decision.
   *
   *   POST /api/v1/admin/qa3-3b-reconciliation/merge-14-into-13 { "dryRun": true }
   *
   * Same safety guarantees as the main run() — atomic, reversible via
   * dryRun, NODE_ENV=production refuses.
   */
  @Post('merge-14-into-13')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Merge service_type 14 into 13 (repoint tasks + junctions, delete 14). Audit service_type 8. Idempotent, dryRun-reversible. TEMPORARY.',
  })
  async mergeFourteenIntoThirteen(
    @Body() body: { dryRun?: boolean } = {},
  ) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'qa3-3b-reconciliation is staging-only. NODE_ENV=production refuses to run.',
      );
    }

    const dryRun = body?.dryRun === true;
    const ranAt = new Date().toISOString();

    try {
      const payload = await this.prisma.$transaction(async (tx) => {
        const source = await tx.serviceType.findUnique({
          where: { id: 14 },
          select: { id: true, name: true, code: true },
        });
        const target = await tx.serviceType.findUnique({
          where: { id: 13 },
          select: { id: true, name: true, code: true },
        });

        // Tasks that will be repointed. Include soft-deleted so no rows
        // are silently orphaned — a soft-deleted task still has an FK
        // constraint on service_types when we try to DELETE the row.
        const taskRefsBefore = await tx.task.findMany({
          where: { serviceTypeId: 14 },
          select: {
            id: true,
            name: true,
            projectId: true,
            project: { select: { id: true, name: true, number: true } },
          },
        });

        const zoneRefsBefore = await tx.zoneServiceType.findMany({
          where: { serviceTypeId: 14 },
          select: { zoneId: true, serviceTypeId: true },
        });

        // Preflight: audit every FK-holder on service_types. Task and
        // ZoneServiceType we know how to repoint safely; anything else
        // pointing at 14 is unexpected and blocks the merge — refuse
        // rather than silently drop rows or fail on the DELETE.
        const projectCategoryRefsOn14 = await tx.projectCategory.count({
          where: { serviceTypeId: 14 },
        });
        const templateRefsOn14: number = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*) AS n FROM templates WHERE service_type_id = 14
        `.then((rows) => Number(rows?.[0]?.n ?? 0));
        const templateZoneRefsOn14: number = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*) AS n FROM template_zone_items WHERE service_type_id = 14
        `.then((rows) => Number(rows?.[0]?.n ?? 0));
        const unexpectedRefs = {
          projectCategoryRefsOn14,
          templateRefsOn14,
          templateZoneRefsOn14,
        };
        const unexpectedTotal =
          projectCategoryRefsOn14 + templateRefsOn14 + templateZoneRefsOn14;
        if (unexpectedTotal > 0) {
          // Rollback via a normal throw — surfaces the audit to the
          // caller so we know exactly what's blocking the merge.
          throw new DryRunRollback({
            error: 'MERGE_BLOCKED_UNEXPECTED_REFS',
            unexpectedRefs,
            hint: 'Handle these refs before running the merge again.',
          });
        }

        // Repoint tasks. updateMany reports count so we can prove
        // idempotency on a re-run (second run → 0 rows updated).
        const tasksUpdated = source
          ? await tx.task.updateMany({
              where: { serviceTypeId: 14 },
              data: { serviceTypeId: 13 },
            })
          : { count: 0 };

        // Repoint ZoneServiceType junction rows. This one needs manual
        // handling because the junction has @@unique([zoneId,
        // serviceTypeId]) — an existing (zone,13) row would clash. So:
        // for each source (zone,14), if (zone,13) already exists we
        // just DELETE the (zone,14) row; otherwise we UPDATE it to 13.
        const zoneMoves: Array<{ zoneId: number; action: 'MOVED_TO_13' | 'MERGED_AS_DUP' }> = [];
        for (const r of zoneRefsBefore) {
          const existingTarget = await tx.zoneServiceType.findUnique({
            where: { zoneId_serviceTypeId: { zoneId: r.zoneId, serviceTypeId: 13 } },
          });
          if (existingTarget) {
            await tx.zoneServiceType.delete({
              where: { zoneId_serviceTypeId: { zoneId: r.zoneId, serviceTypeId: 14 } },
            });
            zoneMoves.push({ zoneId: r.zoneId, action: 'MERGED_AS_DUP' });
          } else {
            await tx.zoneServiceType.update({
              where: { zoneId_serviceTypeId: { zoneId: r.zoneId, serviceTypeId: 14 } },
              data: { serviceTypeId: 13 },
            });
            zoneMoves.push({ zoneId: r.zoneId, action: 'MOVED_TO_13' });
          }
        }

        // Final FK sanity — every ref must be gone before we drop 14.
        const [remainingTaskRefs, remainingZoneRefs] = await Promise.all([
          tx.task.count({ where: { serviceTypeId: 14 } }),
          tx.zoneServiceType.count({ where: { serviceTypeId: 14 } }),
        ]);

        let deleteAction: 'DELETED' | 'SKIPPED_FK' | 'SKIPPED_ALREADY_GONE' = 'SKIPPED_FK';
        if (!source) {
          deleteAction = 'SKIPPED_ALREADY_GONE';
        } else if (remainingTaskRefs === 0 && remainingZoneRefs === 0) {
          await tx.serviceType.delete({ where: { id: 14 } });
          deleteAction = 'DELETED';
        }

        // Audit for service_type 8 (מלונאות) — user asked us to KEEP
        // it and show the task/project so Yulian can pick its real
        // service later. Read-only, doesn't affect the merge.
        const audit8 = await tx.task.findMany({
          where: { serviceTypeId: 8, deletedAt: null },
          select: {
            id: true,
            name: true,
            projectId: true,
            project: { select: { id: true, name: true, number: true } },
          },
        });

        const after = {
          serviceType13: await tx.serviceType.findUnique({
            where: { id: 13 },
            select: { id: true, name: true, _count: { select: { tasks: true, zoneServiceTypes: true } } },
          }),
          serviceType14Exists: !!(await tx.serviceType.findUnique({ where: { id: 14 } })),
          taskRefsOn13: await tx.task.count({ where: { serviceTypeId: 13 } }),
        };

        const result = {
          dryRun,
          ranAt,
          nodeEnv: process.env.NODE_ENV,
          source,
          target,
          before: {
            taskRefsOn14: taskRefsBefore.map((t) => ({
              id: t.id,
              name: t.name,
              projectId: t.projectId,
              projectName: t.project?.name ?? null,
              projectNumber: t.project?.number ?? null,
            })),
            zoneRefsOn14: zoneRefsBefore.length,
          },
          actions: {
            tasksRepointed: tasksUpdated.count,
            zoneMoves,
            delete14: deleteAction,
          },
          after,
          audit_serviceType8_taskList: audit8.map((t) => ({
            id: t.id,
            name: t.name,
            projectId: t.projectId,
            projectName: t.project?.name ?? null,
            projectNumber: t.project?.number ?? null,
          })),
        };

        if (dryRun) {
          throw new DryRunRollback(result);
        }
        return result;
      });

      return payload;
    } catch (err) {
      if (err instanceof DryRunRollback) {
        // The dry-run path throws the built payload up so we can return
        // it without the enclosing $transaction actually committing.
        return err.payload as unknown;
      }
      throw err;
    }
  }
}
