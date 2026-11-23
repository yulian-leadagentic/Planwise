import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { TasksService } from './tasks.service';
import { TaskChecklistService } from './task-checklist.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser, userHasModulePermission } from '../../common/guards/roles.guard';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { StageTransitionService } from '../../common/services/stage-transition.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import {
  assertFinanceFieldWrites,
  canSeeFinance,
  omitKeys,
} from '../../common/finance/finance-access';

/**
 * Permissions round 2 (B-08) — `GET /tasks/:id` includes the whole
 * project row; `project.budget` is an ambiguous name the global
 * interceptor does not strip, so it goes here (with the task's own
 * money, so the endpoint is safe on its own).
 */
export function redactTaskMoney<T extends Record<string, any>>(task: T): T {
  if (!task || typeof task !== 'object') return task;
  const out: Record<string, any> = omitKeys(task, ['budgetAmount']);
  if (out.project) out.project = omitKeys(out.project, ['budget', 'estimatedValue']);
  if (Array.isArray(out.assignees)) out.assignees = omitKeys(out.assignees, ['hourlyRate']);
  return out as T;
}

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly access: ProjectAccessService,
    private readonly transitions: StageTransitionService,
    private readonly checklist: TaskChecklistService,
  ) {}

  /**
   * Round 4 — restore access. An archived task is invisible to
   * assertTaskAccess, so its project (or, for a personal task, its
   * creator / assignees) is checked here.
   */
  private async assertRestoreAccess(user: any, id: number): Promise<void> {
    const archived = await this.tasksService.findArchivedForAccess(id);
    if (!archived) {
      // Live or missing: the normal check (404 when missing).
      await this.access.assertTaskAccess(user.id, id, isAdminUser(user));
      return;
    }
    if (archived.projectId != null) {
      await this.access.assertProjectAccess(user.id, archived.projectId, isAdminUser(user));
      return;
    }
    if (isAdminUser(user) || archived.createdBy === user.id || archived.assigneeIds.includes(user.id)) return;
    throw new PermissionDeniedException(
      'This is a personal task — only the person who created it and its assignees can open it.',
      { module: 'tasks', reason: 'PERSONAL_TASK' },
    );
  }

  /** The project leader, an Admin or a holder of tasks:approve — else 403. */
  private assertApprover(user: any, ctx: { leaderId: number | null }): void {
    const allowed =
      isAdminUser(user) ||
      (ctx.leaderId != null && ctx.leaderId === user.id) ||
      userHasModulePermission(user, 'tasks', 'approve');
    if (!allowed) {
      throw new PermissionDeniedException(
        'Only the project leader, an administrator or someone with permission to approve tasks can approve this task.',
        { module: 'tasks', action: 'approve' },
      );
    }
  }

  /**
   * Round 4 (D-20) — approve: the project leader, an Admin or a holder of
   * tasks:approve; only from In Review; through the stage-transition rules.
   */
  private async assertCanApprove(
    user: any,
    ctx: { status: string; leaderId: number | null },
  ): Promise<void> {
    this.assertApprover(user, ctx);
    if (ctx.status !== 'in_review') {
      throw new BadRequestException({
        code: 'TASK_NOT_IN_REVIEW',
        message: 'Only a task that is In Review can be approved.',
      });
    }
    await this.transitions.assertTransition(user, ctx.status, 'completed');
  }

  /**
   * Round 4 (review fix) — PATCH /tasks/:id is the path every board uses
   * (kanban drag, bulk status, My Tasks, the planning grid), so it must
   * not be a way around approve:
   *   • Done on a task that requires review, or that is In Review, IS an
   *     approve — the same rule as POST /tasks/:id/review (leader / Admin
   *     / tasks:approve; only from In Review → 400 TASK_NOT_IN_REVIEW).
   *   • Switching the review step off on a task that requires it would
   *     let the next PATCH skip approve, so it needs the same approver.
   * A task without review keeps the plain stage-transition rule.
   */
  private async assertStatusChange(user: any, id: number, dto: UpdateTaskDto): Promise<void> {
    const turnsReviewOff = dto.requiresReview === false;
    if (!dto.status && !turnsReviewOff) return;
    const ctx = await this.tasksService.getReviewContext(id);

    if (dto.status && dto.status !== ctx.status) {
      const reviewed = ctx.requiresReview || dto.requiresReview === true || ctx.status === 'in_review';
      if (dto.status === 'completed' && reviewed) {
        await this.assertCanApprove(user, ctx);
      } else {
        await this.transitions.assertTransition(user, ctx.status, dto.status);
      }
    }
    if (turnsReviewOff && ctx.requiresReview) this.assertApprover(user, ctx);
  }

  @Post()
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Create a task' })
  async create(@CurrentUser() user: any, @Body() dto: CreateTaskDto) {
    // Two access paths:
    //   • zoned task: zone access (which implies project access)
    //   • root task:  project access directly
    if (dto.zoneId != null) {
      await this.access.assertZoneAccess(user.id, dto.zoneId, isAdminUser(user));
    } else if (dto.projectId != null) {
      await this.access.assertProjectAccess(user.id, dto.projectId, isAdminUser(user));
    } else {
      // The service will throw with a clearer message; bail before doing
      // a permission check on undefined.
    }
    // Permissions round 2 (B-13) — a budget amount on create needs finance:write.
    await assertFinanceFieldWrites(user, dto, ['budgetAmount'], null);
    return this.tasksService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List tasks with filters' })
  async findAll(@CurrentUser() user: any, @Query() query: QueryTasksDto) {
    if (query.projectId) {
      await this.access.assertProjectAccess(user.id, +query.projectId, isAdminUser(user));
      return this.tasksService.findAll(query);
    }
    const acc = await this.access.getAccessibleProjectIds(user.id, isAdminUser(user));
    if (acc.all) return this.tasksService.findAll(query);
    if (acc.projectIds.length === 0) {
      return { data: [], meta: { total: 0, page: 1, perPage: query.perPage ?? 20, totalPages: 0 } };
    }
    return this.tasksService.findAll(query, acc.projectIds);
  }

  @Get('mine')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List tasks assigned to current user' })
  findMine(@CurrentUser() user: any) {
    // /mine is intrinsically scoped to the user — no project check needed
    return this.tasksService.findMine(user.id);
  }

  @Get('allowed-transitions')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'Get allowed status transitions for the current user\'s role' })
  async getAllowedTransitions(@CurrentUser() user: any, @Query('fromStatus') fromStatus?: string) {
    if (fromStatus) {
      const targets = await this.transitions.getAllowedTargets(user, fromStatus);
      return { fromStatus, targets };
    }
    const matrix = await this.transitions.getMatrix(user.roleId);
    return { matrix, unrestricted: Object.keys(matrix).length === 0 };
  }

  @Get(':id')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'Get task by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertTaskAccess(user.id, id, isAdminUser(user));
    const task = await this.tasksService.findOne(id);
    return canSeeFinance(user) ? task : redactTaskMoney(task);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Update a task' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    await this.access.assertTaskAccess(user.id, id, isAdminUser(user));
    // Round 4 — the target zone / project needs access too; the service
    // keeps the task inside its own project (CROSS_PROJECT_MOVE).
    if (dto.zoneId != null) await this.access.assertZoneAccess(user.id, dto.zoneId, isAdminUser(user));
    if (dto.projectId != null) await this.access.assertProjectAccess(user.id, dto.projectId, isAdminUser(user));
    // Permissions round 2 (B-13) — changing budgetAmount needs
    // finance:write; sending the stored value back unchanged passes.
    await assertFinanceFieldWrites(user, dto, ['budgetAmount'], () =>
      this.tasksService.getMoneySnapshot(id),
    );
    // Status change: stage-transition rules, and approve for a reviewed task.
    await this.assertStatusChange(user, id, dto);
    return this.tasksService.update(id, dto, user?.id);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'tasks', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a task' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertTaskAccess(user.id, id, isAdminUser(user));
    return this.tasksService.remove(id);
  }

  // Restore a soft-deleted (archived) task. Mirrored on the frontend
  // by the Restore button on the Archived tab. Round 4 (D-09): project
  // access is checked on the archived task's project.
  @Post(':id/restore')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Restore an archived task' })
  async restore(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertRestoreAccess(user, id);
    return this.tasksService.restore(id);
  }

  // ─── Review workflow (Tier D #2 + #2a) ─────────────────────────
  // POST /tasks/:id/review — record a review action + optional reason.
  //   action: 'submit'  → task goes to in_review
  //           'approve' → task goes to completed
  //           'return'  → task goes back to in_progress with a reason
  // The write is a single atomic step: bump the task's status AND
  // append a row to task_review_events for the analytics feed.
  @Post(':id/review')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Record a task review action (submit/approve/return)' })
  async recordReview(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { action: 'submit' | 'approve' | 'return'; reason?: string },
    @CurrentUser() user: any,
  ) {
    await this.access.assertTaskAccess(user.id, id, isAdminUser(user));
    if (body?.action === 'approve') {
      await this.assertCanApprove(user, await this.tasksService.getReviewContext(id));
    }
    return this.tasksService.recordReview(id, user.id, body.action, body.reason);
  }

  @Get(':id/reviews')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List review events on this task, newest first' })
  async listReviews(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    await this.access.assertTaskAccess(user.id, id, isAdminUser(user));
    return this.tasksService.listReviews(id);
  }

  // `GET /tasks/reports/review-summary` was removed in round 4: company-
  // wide stats with no project scope, and nothing in the web called it.

  // Assignees
  @Post(':id/assignees')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add assignee to task' })
  async addAssignee(
    @Param('id', ParseIntPipe) taskId: number,
    @Body() body: { userId: number; role?: string; hourlyRate?: number },
    @CurrentUser() user: any,
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    // Permissions round 2 (B-13) — the untyped body can carry the legacy
    // per-assignment `hourlyRate`; setting one needs finance:write.
    await assertFinanceFieldWrites(user, body, ['hourlyRate'], null);
    return this.tasksService.addAssignee(taskId, body, user?.id);
  }

  @Delete(':id/assignees/:userId')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Remove assignee from task' })
  async removeAssignee(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) taskId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.tasksService.removeAssignee(taskId, userId, user?.id);
  }

  // Checklist — sub-items inside a task, NOT separate tasks. Read is gated
  // on tasks:read (anyone who can see the task can tick boxes off, which
  // matches how teams use the feature); add/delete require tasks:write.
  // Round 4: every route checks access to the item's task.
  @Get(':id/checklist')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List checklist items on a task' })
  async listChecklist(@CurrentUser() user: any, @Param('id', ParseIntPipe) taskId: number) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.checklist.list(taskId);
  }

  @Post(':id/checklist')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add a checklist item to a task' })
  async addChecklistItem(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) taskId: number,
    @Body() body: { text: string },
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    const text = (body?.text ?? '').trim();
    // A missing field is a 400, not a 403 (the web shows 403s as "No permission").
    if (!text) throw new BadRequestException('Checklist item text is required.');
    return this.checklist.create(taskId, user.id, text);
  }

  @Patch('checklist/:itemId')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'Update a checklist item (edit text or toggle done)' })
  async updateChecklistItem(
    @CurrentUser() user: any,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() body: { text?: string; isDone?: boolean },
  ) {
    // Authorize on the parent task.
    const taskId = await this.checklist.getItemTaskId(itemId);
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.checklist.update(itemId, user.id, body ?? {});
  }

  @Delete('checklist/:itemId')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Remove a checklist item (soft delete)' })
  async removeChecklistItem(@CurrentUser() user: any, @Param('itemId', ParseIntPipe) itemId: number) {
    const taskId = await this.checklist.getItemTaskId(itemId);
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.checklist.remove(itemId);
  }

  @Post('checklist/reorder')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Bulk-update sortOrder of checklist items' })
  async reorderChecklist(
    @CurrentUser() user: any,
    @Body() body: { items: Array<{ id: number; sortOrder: number }> },
  ) {
    const items = body?.items ?? [];
    // Items may span tasks: every task needs access.
    for (const taskId of await this.checklist.getItemsTaskIds(items.map((i) => i.id))) {
      await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    }
    return this.checklist.reorder(items);
  }

  // Comments
  @Get(':id/comments')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List task comments' })
  async getComments(@CurrentUser() user: any, @Param('id', ParseIntPipe) taskId: number) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.tasksService.getComments(taskId);
  }

  @Post(':id/comments')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add comment to task' })
  async addComment(
    @Param('id', ParseIntPipe) taskId: number,
    @CurrentUser() user: any,
    @Body() body: { content: string; parentId?: number; attachmentIds?: number[] },
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.tasksService.addComment(taskId, user.id, body);
  }

  // Batch reorder
  @Post('reorder')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Batch reorder tasks' })
  async reorder(@CurrentUser() user: any, @Body() body: { items: { id: number; sortOrder: number; zoneId?: number }[] }) {
    // Verify access to every task being reordered
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      throw new BadRequestException('Nothing to reorder — the list of tasks is empty.');
    }
    for (const item of body.items) {
      await this.access.assertTaskAccess(user.id, item.id, isAdminUser(user));
    }
    return this.tasksService.batchReorder(body.items);
  }

  // Attachments
  @Get(':id/attachments')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List task attachments' })
  async getAttachments(@CurrentUser() user: any, @Param('id', ParseIntPipe) taskId: number) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.tasksService.getAttachments(taskId);
  }

  @Post(':id/attachments')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add attachment to task' })
  async addAttachment(
    @Param('id', ParseIntPipe) taskId: number,
    @CurrentUser() user: any,
    @Body() body: { fileName: string; fileUrl: string; fileSize?: number; mimeType?: string },
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.tasksService.addAttachment(taskId, user.id, body);
  }

  @Delete('attachments/:attachmentId')
  @RequirePermissions({ module: 'tasks', action: 'delete' })
  @ApiOperation({ summary: 'Delete task attachment' })
  async removeAttachment(@CurrentUser() user: any, @Param('attachmentId', ParseIntPipe) attachmentId: number) {
    // Resolve attachment → task → project, then assert access
    await this.tasksService.assertAttachmentAccess(attachmentId, async (taskId) => {
      await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    });
    return this.tasksService.removeAttachment(attachmentId, user?.id);
  }
}
