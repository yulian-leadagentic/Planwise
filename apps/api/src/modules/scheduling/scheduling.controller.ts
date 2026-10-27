import { Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { SchedulerService } from './scheduler.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * T3 · Scheduling endpoints
 * -------------------------------------------------------------------
 * Two explicit entry points — a dry-run that computes without side
 * effects and a commit path that persists `estimatedStartDate` +
 * `endDate` under a Prisma transaction. No automatic triggers in
 * this pass (spec defers event-sourced recompute to a follow-up);
 * callers choose when a deliverable is (re-)scheduled.
 */
@ApiTags('Scheduling')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class SchedulingController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Post('deliverables/:id/schedule/dry-run')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Compute a working-day schedule for a ZoneDeliverableTarget without writing' })
  dryRun(@Param('id', ParseIntPipe) id: number) {
    return this.scheduler.scheduleDeliverableDryRun({ deliverableId: id });
  }

  @Post('deliverables/:id/schedule/commit')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Compute and persist a working-day schedule (updates Task.estimatedStartDate + endDate; preserves overrides)' })
  commit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.scheduler.scheduleDeliverableAndCommit({ deliverableId: id }, user?.id);
  }

  // ─── D3 · Overload scan ────────────────────────────────────────────
  //
  // Dry-runs the scheduler across every deliverable of a project
  // (and the aggregated variant across every active project), then
  // returns only the tasks the engine flagged `infeasible: true` with
  // the surrounding metadata the PM dashboard needs. No writes.
  //
  // `projects:read` is intentional — the scan surfaces a problem the
  // PM should see; it is not itself a schedule mutation, so read is
  // enough. The underlying `scheduleDeliverableDryRun` only reads.

  @Post('scheduling/projects/:projectId/overload-scan')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'D3 · Scan every deliverable in a project for infeasible / overloaded tasks' })
  scanProjectOverload(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.scheduler.scanProjectOverload(projectId);
  }

  @Get('scheduling/overload-scan/all')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'D3 · Scan every active, non-archived project for infeasible / overloaded tasks' })
  scanAllOverload() {
    return this.scheduler.scanAllActiveOverload();
  }
}
