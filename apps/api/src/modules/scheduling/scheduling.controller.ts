import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { SchedulerService } from './scheduler.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';

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
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly access: ProjectAccessService,
  ) {}

  @Post('deliverables/:id/schedule/dry-run')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      'Compute a working-day schedule for a ZoneDeliverableTarget without writing. Optional { anchorDate } simulates the deliverable at a different target date (§8c · preview target picker) — the scheduler treats it as the effective targetDate for the dry-run only.',
  })
  dryRun(
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { anchorDate?: string },
  ) {
    const anchorDate = body?.anchorDate ? new Date(body.anchorDate) : undefined;
    return this.scheduler.scheduleDeliverableDryRun({ deliverableId: id, anchorDate });
  }

  // ─── §10 (2026-11-13) · Dry-run by (ProjectDeliverable × Zone) ─────
  //
  // The route above is keyed by a ZoneDeliverableTarget id, which the
  // Deliverable Planning UI never receives — it only holds the
  // ProjectDeliverable id + the zone id. Passing a ProjectDeliverable
  // id there 404s (or, worse, schedules an unrelated ZDT that happens
  // to share the numeric id). This route takes what the client has and
  // resolves the ZDT server-side. No writes.
  //
  // `:id` is a ProjectDeliverable id. Unlike the ZDT-keyed route this
  // one asserts project access first (the caller-supplied id is
  // resolved to its project → `assertProjectAccess`).
  //
  // Empty outcomes return 200 with `scheduled: []` and
  // `feasibility.reason` = 'no-zone' (no zoneId — deliverable-level
  // target) or 'no-target-row' (pair has no saved target yet).
  @Post('project-deliverables/:id/schedule/dry-run')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      '§10 · Compute a working-day schedule for a (ProjectDeliverable × Zone) pair without writing. Body { zoneId, anchorDate? } — the ZoneDeliverableTarget is resolved server-side; optional anchorDate simulates a different target date for the dry-run only.',
  })
  async dryRunForProjectDeliverable(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { zoneId?: number | null; anchorDate?: string },
  ) {
    // Inline body type → the global ValidationPipe has nothing to
    // validate against, so guard the two fields by hand.
    let zoneId: number | null = null;
    const rawZoneId: unknown = body?.zoneId;
    if (rawZoneId != null) {
      const n =
        typeof rawZoneId === 'number'
          ? rawZoneId
          : typeof rawZoneId === 'string' && rawZoneId.trim() !== ''
            ? Number(rawZoneId)
            : NaN;
      if (!Number.isInteger(n)) {
        throw new BadRequestException('zoneId must be an integer');
      }
      zoneId = n;
    }

    let anchorDate: Date | undefined;
    const rawAnchor: unknown = body?.anchorDate;
    if (rawAnchor != null) {
      const d = typeof rawAnchor === 'string' && rawAnchor.trim() !== '' ? new Date(rawAnchor) : null;
      if (!d || Number.isNaN(d.getTime())) {
        throw new BadRequestException('anchorDate must be an ISO date');
      }
      anchorDate = d;
    }

    const projectId = await this.scheduler.getProjectIdForProjectDeliverable(id);
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);

    return this.scheduler.scheduleProjectDeliverableDryRun({
      projectDeliverableId: id,
      zoneId,
      anchorDate,
    });
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

  // ─── D4 · Save & update due dates ──────────────────────────────────
  //
  // Called by the Deliverable-Planning tab's primary "Save & update
  // due dates" button AFTER the FE has persisted deliverable target
  // changes via `POST /project-deliverables/targets/batch`. Runs the
  // scheduler across every deliverable in the project, auto-commits
  // the safe rows, and returns the problematic rows (manual override,
  // overload, hours-logged) for PM review.

  @Post('scheduling/projects/:projectId/save-and-update-due-dates')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      'D4 · Reschedule all deliverables in a project; auto-commit safe tasks, return the problematic ones for PM review. Optional { taskIds } (§8a) limits the write to a PM-approved subset after a preview-reschedule round-trip.',
  })
  saveAndUpdateDueDates(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: any,
    @Body() body?: { taskIds?: number[] },
  ) {
    const taskIds =
      Array.isArray(body?.taskIds)
        ? body!.taskIds.filter((n): n is number => Number.isInteger(n))
        : undefined;
    return this.scheduler.saveAndUpdateDueDates(projectId, user?.id, { taskIds });
  }

  // ─── §8a · Preview reschedule ──────────────────────────────────────
  //
  // Dry-runs the project-wide reschedule and returns a per-task diff
  // (before/after dates + markers for violatesTarget / hoursLogged /
  // onCriticalPath). No DB side effects — the scheduler runs read-only
  // and no writes are issued. The Review Modal opens on this payload,
  // then calls `save-and-update-due-dates` with the approved
  // `{ taskIds }` subset. Same `projects:write` guard as the live
  // commit path (the preview still accesses project-level scheduling
  // data a read-only viewer should not be able to drive from the UI).
  @Post('scheduling/projects/:projectId/preview-reschedule')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      '§8a · Dry-run the project-wide reschedule and return a per-task diff (no writes).',
  })
  previewReschedule(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.scheduler.previewReschedule(projectId);
  }

  @Post('scheduling/projects/:projectId/apply-reviewed')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      'D4 · Commit the PM-approved review rows (new endDate per task; estimatedStartDate recomputed from duration)',
  })
  applyReviewed(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: any,
    @Body() body: { approvals: Array<{ taskId: number; acceptedEnd: string }> },
  ) {
    return this.scheduler.applyReviewed(projectId, body?.approvals ?? [], user?.id);
  }
}
