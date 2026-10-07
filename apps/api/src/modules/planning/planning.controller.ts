import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { PlanningService } from './planning.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';

@ApiTags('Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class PlanningController {
  constructor(
    private readonly planningService: PlanningService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get(':id/planning-data')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get combined planning data for the planning modal' })
  async getPlanningData(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertProjectAccess(user.id, id, user.roleId);
    return this.planningService.getPlanningData(id);
  }
}

/**
 * Admin surface for the UI-15 TaskTypicalRank aggregate.
 *
 * Separate controller (NOT the main `/projects` one above) so it
 * mounts under `/admin/planning` and is guarded by `admin:write`.
 * Idempotent: re-running `recompute` on an unchanged DB just rewrites
 * the same medians.
 *
 * This stays OUT of `apps/api/src/modules/admin/backfills.controller.ts`
 * on purpose — that file is off-limits for this wave (QA5 Wave 3
 * guardrails).
 */
@ApiTags('Admin - Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/planning')
export class PlanningAdminController {
  constructor(private readonly planningService: PlanningService) {}

  /**
   * Rebuild the `TaskTypicalRank` cache from every dated task across
   * the DB. Bounded; see `PlanningService.recomputeTaskTypicalRanks`.
   * Returns the aggregate stats so Yulian can confirm the write
   * landed.
   */
  @Post('recompute-task-typical-ranks')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      'Recompute the TaskTypicalRank cache from dated tasks (idempotent). Trigger manually; do NOT wire into a request path.',
  })
  async recomputeTypicalRanks() {
    return this.planningService.recomputeTaskTypicalRanks();
  }

  /**
   * Peek at the largest-sample buckets so the operator can sanity-
   * check the recompute without opening the DB. Read-only.
   */
  @Get('typical-ranks/top')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List the top-N TaskTypicalRank buckets by sampleSize (debug).' })
  async topBuckets(@Query('limit') limit?: string) {
    const n = Number(limit) || 10;
    return this.planningService.listTopTypicalRanks(n);
  }
}
