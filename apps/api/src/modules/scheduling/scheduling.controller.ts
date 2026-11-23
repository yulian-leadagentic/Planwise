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
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';

/**
 * §14 (2026-11-15) · Hand-validation for the id lists in the inline
 * (untyped) bodies below — the global ValidationPipe has no DTO class
 * to check them against. Same rule the `taskIds` filter always used:
 * an array keeps its integer entries, anything else reads as "not
 * sent". Never throws: a stray id simply matches no task downstream.
 */
function integerIdsOrUndefined(raw: unknown): number[] | undefined {
  return Array.isArray(raw)
    ? raw.filter((n): n is number => Number.isInteger(n))
    : undefined;
}

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
  async dryRun(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { anchorDate?: string },
  ) {
    // Round 4: the target's project must be accessible.
    await this.assertProject(user, await this.scheduler.getProjectIdForTarget(id));
    const anchorDate = body?.anchorDate ? new Date(body.anchorDate) : undefined;
    return this.scheduler.scheduleDeliverableDryRun({ deliverableId: id, anchorDate });
  }

  private assertProject(user: any, projectId: number): Promise<void> {
    return this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
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
  // target) or 'no-target-row' (no saved target on the zone or any zone
  // above it).
  //
  // §16 (2026-11-18) · A zone with no target row of its own (a DP row on
  // a sub-zone, target saved on an ancestor) is previewed as if it had
  // one: the closest ancestor target carries the run, the scope is the
  // requested zone's sub-tree. See `scheduleProjectDeliverableDryRun`.
  //
  // §14 (2026-11-15) · Optional `releaseOverrideTaskIds`: manual tasks
  // (`dueDateOverridden`) to schedule as if they were not overridden.
  // Every `scheduled[]` row carries `manual` (the stored flag) and
  // `skippedByOverride` (pinned in THIS run), so the caller can tell a
  // released manual row (`manual && !skippedByOverride`) from a pinned
  // one. Still no writes — nothing is released in the database.
  @Post('project-deliverables/:id/schedule/dry-run')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      '§10 · Compute a working-day schedule for a (ProjectDeliverable × Zone) pair without writing. Body { zoneId, anchorDate?, releaseOverrideTaskIds? } — the ZoneDeliverableTarget is resolved server-side; optional anchorDate simulates a different target date for the dry-run only. §14 · optional releaseOverrideTaskIds (task ids) schedules those manually-dated tasks as if they were not overridden; each scheduled row reports manual (stored dueDateOverridden) and skippedByOverride (pinned in this run).',
  })
  async dryRunForProjectDeliverable(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body?: { zoneId?: number | null; anchorDate?: string; releaseOverrideTaskIds?: number[] },
  ) {
    // Inline body type → the global ValidationPipe has nothing to
    // validate against, so guard the fields by hand.
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
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    // Round 4: no zone from another project.
    if (zoneId != null) await this.scheduler.assertZoneInProject(zoneId, projectId);

    return this.scheduler.scheduleProjectDeliverableDryRun({
      projectDeliverableId: id,
      zoneId,
      anchorDate,
      releaseOverrideTaskIds: integerIdsOrUndefined(body?.releaseOverrideTaskIds),
    });
  }

  @Post('deliverables/:id/schedule/commit')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Compute and persist a working-day schedule (updates Task.estimatedStartDate + endDate; preserves overrides)' })
  async commit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    await this.assertProject(user, await this.scheduler.getProjectIdForTarget(id));
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
  async scanProjectOverload(@CurrentUser() user: any, @Param('projectId', ParseIntPipe) projectId: number) {
    await this.assertProject(user, projectId);
    return this.scheduler.scanProjectOverload(projectId);
  }

  @Get('scheduling/overload-scan/all')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'D3 · Scan every active, non-archived project the caller can access for infeasible / overloaded tasks' })
  async scanAllOverload(@CurrentUser() user: any) {
    // Round 4: only the caller's accessible projects (Admin: all).
    const accessible = await this.access.getAccessibleProjectIds(user.id, isAdminUser(user));
    return this.scheduler.scanAllActiveOverload(accessible.all ? undefined : accessible.projectIds);
  }

  // ─── D4 · Save & update due dates ──────────────────────────────────
  //
  // Called by the Deliverable-Planning tab's primary "Save & update
  // due dates" button AFTER the FE has persisted deliverable target
  // changes via `POST /project-deliverables/targets/batch`. Runs the
  // scheduler across every deliverable in the project, auto-commits
  // the safe rows, and returns the problematic rows (manual override,
  // overload, hours-logged) for PM review.
  //
  // §14 (2026-11-15) · `releaseOverrideTaskIds` — the manual tasks the
  // preview that preceded this call was asked to release. Only read
  // together with `taskIds`: an approved task that is also released is
  // written with its computed dates and loses `dueDateOverridden`.
  // Sent without `taskIds` it is ignored (the automatic path keeps
  // every manual date).

  @Post('scheduling/projects/:projectId/save-and-update-due-dates')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      'D4 · Reschedule all deliverables in a project; auto-commit safe tasks, return the problematic ones for PM review. Optional { taskIds } (§8a) limits the write to a PM-approved subset after a preview-reschedule round-trip. §14 · optional { releaseOverrideTaskIds } (honoured only together with taskIds; send the same list the preview was given) releases the manual due date of those tasks: an approved + released task gets its computed dates and dueDateOverridden=false; a released task that is not in taskIds is left untouched.',
  })
  async saveAndUpdateDueDates(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: any,
    @Body() body?: { taskIds?: number[]; releaseOverrideTaskIds?: number[] },
  ) {
    await this.assertProject(user, projectId);
    return this.scheduler.saveAndUpdateDueDates(projectId, user?.id, {
      taskIds: integerIdsOrUndefined(body?.taskIds),
      releaseOverrideTaskIds: integerIdsOrUndefined(body?.releaseOverrideTaskIds),
    });
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
  //
  // §14 (2026-11-15) · Optional body `{ releaseOverrideTaskIds }`: the
  // manual tasks to preview as released (dates derived back from the
  // target like any other task). Every preview row carries `manual`
  // (the stored `dueDateOverridden`); a released row has
  // `skippedByOverride: false` and computed "after" dates. To commit
  // what was shown, send the same list to `save-and-update-due-dates`
  // next to the approved `taskIds`.
  @Post('scheduling/projects/:projectId/preview-reschedule')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      '§8a · Dry-run the project-wide reschedule and return a per-task diff (no writes). §14 · optional body { releaseOverrideTaskIds } previews those manually-dated tasks as released; each row reports manual (stored dueDateOverridden) and skippedByOverride (still pinned).',
  })
  async previewReschedule(
    @CurrentUser() user: any,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() body?: { releaseOverrideTaskIds?: number[] },
  ) {
    await this.assertProject(user, projectId);
    return this.scheduler.previewReschedule(projectId, {
      releaseOverrideTaskIds: integerIdsOrUndefined(body?.releaseOverrideTaskIds),
    });
  }

  @Post('scheduling/projects/:projectId/apply-reviewed')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({
    summary:
      'D4 · Commit the PM-approved review rows (new endDate per task; estimatedStartDate recomputed from duration)',
  })
  async applyReviewed(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: any,
    @Body() body: { approvals: Array<{ taskId: number; acceptedEnd: string }> },
  ) {
    await this.assertProject(user, projectId);
    return this.scheduler.applyReviewed(projectId, body?.approvals ?? [], user?.id);
  }
}
