/**
 * TEMPORARY read-only endpoint for QA3 Wave-1 Commit 2 · Failure B investigation.
 *
 * See docs/bm2/qa3-auth-wedge-deep-dive.md §3 Step 2 — DB integrity scan of
 * migrated projects. This exposes those queries as JSON-over-HTTP so the
 * investigator can hit them without SSH (which routes randomly during a
 * rolling deploy and lands on the draining container).
 *
 * Scope discipline:
 *   • Read-only. No writes, no INSERT, no UPDATE, no DELETE.
 *   • Admin-gated behind the same JwtAuthGuard + RolesGuard pattern the
 *     rest of admin/* uses.
 *   • Slated for removal once Wave-1 closes and the cleanup migration
 *     (gate #6a) has been applied and verified. Do not build on this.
 *
 * The queries answer "what's different about this project vs a clean new
 * one?" — orphaned FKs, dangling links, unexpected nulls on the load path,
 * plus row-shape totals so 1660 can be diffed against Carmei Modiin.
 */
import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

// Prisma's $queryRaw returns rows where numeric columns come back as BigInt
// on MySQL (COUNT(*) is a BIGINT). We coerce them to Number so the JSON
// serializer doesn't need the global BigInt.prototype.toJSON hack — keeps
// this endpoint's output flat and obvious.
type CountRow = { n: number | bigint };
const num = (v: unknown): number =>
  typeof v === 'bigint' ? Number(v) : (v as number);

@ApiTags('Admin - QA3 integrity (TEMP)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/qa3-integrity')
export class Qa3IntegrityController {
  constructor(private prisma: PrismaService) {}

  @Get(':projectId')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({
    summary:
      'Read-only integrity + row-shape scan for a project (QA3 Wave-1 investigation, temporary).',
  })
  async scan(@Param('projectId', ParseIntPipe) projectId: number) {
    const startedAt = Date.now();

    // Row-shape totals — used to diff a migrated project (1660) against a
    // clean one (Carmei Modiin). Big deltas in a single count (e.g. 3x tasks
    // per deliverable) tend to be the visible face of a migration bug.
    const [
      projectExists,
      taskTotal,
      taskLive,
      taskArchived,
      deliverableTotal,
      deliverableLive,
      zoneTotal,
      zoneLive,
    ] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM projects WHERE id = ${projectId} AND deleted_at IS NULL
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks WHERE project_id = ${projectId}
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks
        WHERE project_id = ${projectId} AND deleted_at IS NULL AND is_archived = 0
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks
        WHERE project_id = ${projectId} AND is_archived = 1
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM project_deliverables WHERE project_id = ${projectId}
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM project_deliverables
        WHERE project_id = ${projectId} AND deleted_at IS NULL
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM zones WHERE project_id = ${projectId}
      `,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM zones WHERE project_id = ${projectId} AND deleted_at IS NULL
      `,
    ]);

    // Orphaned FKs — the row lives in this project, but the FK points to
    // something that either never existed or has since been hard-deleted.
    // Anti-join with LEFT JOIN + IS NULL, matching the pattern the load
    // path's includes would traverse.
    const [
      taskWithoutProject,
      taskWithoutZone,
      taskWithoutDeliverable,
      taskWithoutService,
      deliverableWithoutProject,
      deliverableWithoutService,
      zoneWithoutProject,
    ] = await Promise.all([
      // Task rows that HAVE project_id NULL but a zone_id: broken parenting.
      // The load path filters by project_id — these rows are invisible to
      // the tree but can still be referenced by an orphaned FK from below.
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks t
        WHERE t.deleted_at IS NULL
          AND t.project_id IS NULL
          AND t.zone_id IN (SELECT id FROM zones WHERE project_id = ${projectId})
      `,
      // task.zone_id → zones.id (allow NULL — root-of-project tasks)
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks t
        LEFT JOIN zones z ON z.id = t.zone_id AND z.deleted_at IS NULL
        WHERE t.project_id = ${projectId}
          AND t.deleted_at IS NULL
          AND t.zone_id IS NOT NULL
          AND z.id IS NULL
      `,
      // task.project_deliverable_id → project_deliverables.id (allow NULL)
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks t
        LEFT JOIN project_deliverables pd
          ON pd.id = t.project_deliverable_id AND pd.deleted_at IS NULL
        WHERE t.project_id = ${projectId}
          AND t.deleted_at IS NULL
          AND t.project_deliverable_id IS NOT NULL
          AND pd.id IS NULL
      `,
      // task.service_type_id → service_types.id (allow NULL)
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM tasks t
        LEFT JOIN service_types s ON s.id = t.service_type_id
        WHERE t.project_id = ${projectId}
          AND t.deleted_at IS NULL
          AND t.service_type_id IS NOT NULL
          AND s.id IS NULL
      `,
      // project_deliverables.project_id → projects.id (never NULL by schema)
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM project_deliverables pd
        LEFT JOIN projects p ON p.id = pd.project_id AND p.deleted_at IS NULL
        WHERE pd.project_id = ${projectId}
          AND pd.deleted_at IS NULL
          AND p.id IS NULL
      `,
      // project_deliverables.service_type_id → service_types.id
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM project_deliverables pd
        LEFT JOIN service_types s ON s.id = pd.service_type_id
        WHERE pd.project_id = ${projectId}
          AND pd.deleted_at IS NULL
          AND s.id IS NULL
      `,
      // zones.project_id → projects.id
      this.prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*) AS n FROM zones z
        LEFT JOIN projects p ON p.id = z.project_id AND p.deleted_at IS NULL
        WHERE z.project_id = ${projectId}
          AND z.deleted_at IS NULL
          AND p.id IS NULL
      `,
    ]);

    // Suspicious nulls the load path doesn't expect. A migration that
    // dropped a required column back to NULL can leave the row visible to
    // the tree but breaks any subsequent transform / rollup that assumes
    // presence.
    const [taskNullName, deliverableNullName, zoneNullName] = await Promise.all(
      [
        this.prisma.$queryRaw<CountRow[]>`
          SELECT COUNT(*) AS n FROM tasks
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND (name IS NULL OR name = '')
        `,
        this.prisma.$queryRaw<CountRow[]>`
          SELECT COUNT(*) AS n FROM project_deliverables
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND (name IS NULL OR name = '')
        `,
        this.prisma.$queryRaw<CountRow[]>`
          SELECT COUNT(*) AS n FROM zones
          WHERE project_id = ${projectId}
            AND deleted_at IS NULL
            AND (name IS NULL OR name = '')
        `,
      ],
    );

    // Duplicate deliverable/zone rows — PR-041 (duplicate deliverables in
    // Execution) may be the visible face of a migration that inserted a
    // twin for each real row. Group by (project_id, name, service_type_id)
    // for deliverables; group by (project_id, parent_id, name) for zones.
    const dupDeliverables = await this.prisma.$queryRaw<
      Array<{ name: string; service_type_id: number | null; n: number | bigint }>
    >`
      SELECT name, service_type_id, COUNT(*) AS n
      FROM project_deliverables
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      GROUP BY name, service_type_id
      HAVING COUNT(*) > 1
      ORDER BY n DESC, name ASC
      LIMIT 10
    `;

    const dupZones = await this.prisma.$queryRaw<
      Array<{ name: string; parent_id: number | null; n: number | bigint }>
    >`
      SELECT name, parent_id, COUNT(*) AS n
      FROM zones
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      GROUP BY name, parent_id
      HAVING COUNT(*) > 1
      ORDER BY n DESC, name ASC
      LIMIT 10
    `;

    return {
      projectId,
      exists: num(projectExists[0]?.n) > 0,
      elapsedMs: Date.now() - startedAt,
      shape: {
        tasks: {
          total: num(taskTotal[0]?.n),
          live: num(taskLive[0]?.n),
          archived: num(taskArchived[0]?.n),
        },
        deliverables: {
          total: num(deliverableTotal[0]?.n),
          live: num(deliverableLive[0]?.n),
        },
        zones: {
          total: num(zoneTotal[0]?.n),
          live: num(zoneLive[0]?.n),
        },
      },
      orphanFks: {
        taskWithoutProject: num(taskWithoutProject[0]?.n),
        taskWithoutZone: num(taskWithoutZone[0]?.n),
        taskWithoutDeliverable: num(taskWithoutDeliverable[0]?.n),
        taskWithoutService: num(taskWithoutService[0]?.n),
        deliverableWithoutProject: num(deliverableWithoutProject[0]?.n),
        deliverableWithoutService: num(deliverableWithoutService[0]?.n),
        zoneWithoutProject: num(zoneWithoutProject[0]?.n),
      },
      unexpectedNulls: {
        taskNullName: num(taskNullName[0]?.n),
        deliverableNullName: num(deliverableNullName[0]?.n),
        zoneNullName: num(zoneNullName[0]?.n),
      },
      duplicates: {
        deliverablesByNameAndService: dupDeliverables.map((r) => ({
          name: r.name,
          serviceTypeId: r.service_type_id,
          count: num(r.n),
        })),
        zonesByNameAndParent: dupZones.map((r) => ({
          name: r.name,
          parentId: r.parent_id,
          count: num(r.n),
        })),
      },
    };
  }
}
