/**
 * TEMPORARY backfill endpoint for QA3 Wave-1 Commit 3C-a · PR-037.
 *
 * The multi-statement migration file
 * (20260922100000_project_category_links) CREATEd the table but the
 * `INSERT IGNORE ... SELECT` didn't populate rows on the staging apply
 * — a projects/GET response after deploy showed 0/22 projects with
 * `categoryLinks`, so we backfill here from the app side.
 *
 * Runs the same INSERT IGNORE as the migration. Fully idempotent:
 * every project already backfilled skips silently. Staging only.
 * Removed at Wave-1 close alongside the other TEMP endpoints.
 *
 *   POST /api/v1/admin/qa3-3c-backfill
 */
import {
  Controller,
  ForbiddenException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Admin - QA3 3C backfill (TEMP)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/qa3-3c-backfill')
export class Qa3ThreeCBackfillController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'One-shot idempotent backfill of project_category_links from Project.projectTypeId. TEMPORARY.',
  })
  async run() {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException(
        'qa3-3c-backfill is staging-only. NODE_ENV=production refuses to run.',
      );
    }

    const [beforeCount] = await this.prisma.$queryRaw<
      Array<{ n: number | bigint }>
    >`SELECT COUNT(*) AS n FROM project_category_links`;

    // Same statement as the migration file — every project.deleted_at IS
    // NULL gets a link row for its current primary FK. INSERT IGNORE
    // makes re-runs no-ops on already-present pairs.
    const inserted = await this.prisma.$executeRaw`
      INSERT IGNORE INTO project_category_links (project_id, project_type_id)
      SELECT id, project_type_id
      FROM projects
      WHERE deleted_at IS NULL
    `;

    const [afterCount] = await this.prisma.$queryRaw<
      Array<{ n: number | bigint }>
    >`SELECT COUNT(*) AS n FROM project_category_links`;

    const num = (v: unknown) =>
      typeof v === 'bigint' ? Number(v) : (v as number);

    return {
      ranAt: new Date().toISOString(),
      nodeEnv: process.env.NODE_ENV,
      rowsAffected: num(inserted),
      beforeCount: num(beforeCount?.n ?? 0),
      afterCount: num(afterCount?.n ?? 0),
    };
  }
}
