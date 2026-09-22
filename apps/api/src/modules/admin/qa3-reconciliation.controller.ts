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
}
