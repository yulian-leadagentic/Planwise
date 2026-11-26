import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions, RequiredPermission } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OPERATIONS_READ } from '../execution-planning/execution-planning.controller';
import { ReassignBody, TaskReassignService } from './task-reassign.service';

const TASKS_WRITE: RequiredPermission = { module: 'tasks', action: 'write' };

/**
 * QA6 package 4 (PR-063) — drag-and-drop task assignment in
 * Operations › Workload. Writes need `tasks:write` (as
 * POST /tasks/:id/assignees), reads `operations:read` (as every
 * `workload/*` read). The reassignment routes live under `workload/`,
 * off the `tasks/` prefix, so `GET tasks/:id` never shadows them.
 * Contract: docs/bm2/qa6-pr063-research.md §10.4 + qa6-pr063-locked-spec.md.
 *
 * Bodies are plain types validated in TaskReassignService (the web sends
 * explicit nulls for "from the tray" / "back to the tray"). The writes
 * answer 200 (actions, not creations), as the contract says.
 */
@ApiTags('Workload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class WorkloadAssignController {
  constructor(private readonly reassign: TaskReassignService) {}

  @Post('tasks/:id/reassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TASKS_WRITE)
  @ApiOperation({ summary: 'Move a task on the Workload board: to another person, another day, from or to the tray' })
  reassignTask(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: ReassignBody) {
    return this.reassign.reassign(user, id, body ?? {});
  }

  @Get('workload/reassignments')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Workload move requests: ?as=approver (default) | requester, ?status=pending (default) | all | …' })
  list(@CurrentUser() user: any, @Query('status') status?: string, @Query('as') as?: string) {
    return this.reassign.list(user, { status, as });
  }

  @Post('workload/reassignments/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TASKS_WRITE)
  @ApiOperation({ summary: 'Approve a cross-department move request (re-validated, then applied)' })
  approve(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: { view?: { from?: string; to?: string } }) {
    return this.reassign.approve(user, id, body ?? {});
  }

  @Post('workload/reassignments/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TASKS_WRITE)
  @ApiOperation({ summary: 'Reject a cross-department move request' })
  reject(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: { note?: string }) {
    return this.reassign.reject(user, id, body ?? {});
  }

  @Post('workload/reassignments/:id/undo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TASKS_WRITE)
  @ApiOperation({ summary: 'Undo a move (15 minutes, unchanged task only); on a pending request: cancel it' })
  undo(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: { view?: { from?: string; to?: string } }) {
    return this.reassign.undo(user, id, body ?? {});
  }
}
