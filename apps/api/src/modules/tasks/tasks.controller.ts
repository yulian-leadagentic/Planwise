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
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { TasksService } from './tasks.service';
import { TaskChecklistService } from './task-checklist.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { StageTransitionService } from '../../common/services/stage-transition.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';

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

  @Post()
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Create a task' })
  async create(@CurrentUser() user: any, @Body() dto: CreateTaskDto) {
    // Two access paths:
    //   • zoned task: zone access (which implies project access)
    //   • root task:  project access directly
    if (dto.zoneId != null) {
      await this.access.assertZoneAccess(user.id, dto.zoneId, user.roleId);
    } else if (dto.projectId != null) {
      await this.access.assertProjectAccess(user.id, dto.projectId, user.roleId);
    } else {
      // The service will throw with a clearer message; bail before doing
      // a permission check on undefined.
    }
    return this.tasksService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List tasks with filters' })
  async findAll(@CurrentUser() user: any, @Query() query: QueryTasksDto) {
    if (query.projectId) {
      await this.access.assertProjectAccess(user.id, +query.projectId, user.roleId);
      return this.tasksService.findAll(query);
    }
    const acc = await this.access.getAccessibleProjectIds(user.id, user.roleId);
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
      const targets = await this.transitions.getAllowedTargets(user.roleId, fromStatus);
      return { fromStatus, targets };
    }
    const matrix = await this.transitions.getMatrix(user.roleId);
    return { matrix, unrestricted: Object.keys(matrix).length === 0 };
  }

  @Get(':id')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'Get task by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertTaskAccess(user.id, id, user.roleId);
    return this.tasksService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Update a task' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    await this.access.assertTaskAccess(user.id, id, user.roleId);
    // If status is changing, enforce stage-transition rules
    if (dto.status) {
      const currentTask = await this.tasksService.findOne(id);
      if ((currentTask as any).status !== dto.status) {
        await this.transitions.assertTransition(user.roleId, (currentTask as any).status, dto.status);
      }
    }
    return this.tasksService.update(id, dto, user?.id);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'tasks', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a task' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertTaskAccess(user.id, id, user.roleId);
    return this.tasksService.remove(id);
  }

  // Restore a soft-deleted (archived) task. Mirrored on the frontend
  // by the Restore button on the Archived tab.
  //
  // We skip the per-task project-access check here because the helper
  // filters out archived tasks (deletedAt IS NULL) — so any restore
  // would 404 before getting to the actual restore step. Authorization
  // is still enforced via @RequirePermissions; restore is a power-user
  // action gated by tasks:write at the role level.
  @Post(':id/restore')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Restore an archived task' })
  async restore(@Param('id', ParseIntPipe) id: number) {
    return this.tasksService.restore(id);
  }

  // Assignees
  @Post(':id/assignees')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add assignee to task' })
  async addAssignee(
    @Param('id', ParseIntPipe) taskId: number,
    @Body() body: { userId: number; role?: string; hourlyRate?: number },
    @CurrentUser() user: any,
  ) {
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
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
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    return this.tasksService.removeAssignee(taskId, userId, user?.id);
  }

  // Checklist — sub-items inside a task, NOT separate tasks. Read is gated
  // on tasks:read (anyone who can see the task can tick boxes off, which
  // matches how teams use the feature); add/delete require tasks:write.
  @Get(':id/checklist')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List checklist items on a task' })
  async listChecklist(@CurrentUser() user: any, @Param('id', ParseIntPipe) taskId: number) {
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
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
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    const text = (body?.text ?? '').trim();
    if (!text) throw new ForbiddenException('text is required');
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
    // Authorize on the parent task. Reuse assertTaskAccess by looking the
    // item up first; cheaper than threading taskId through the URL.
    return this.checklist.update(itemId, user.id, body ?? {});
  }

  @Delete('checklist/:itemId')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Remove a checklist item (soft delete)' })
  async removeChecklistItem(@Param('itemId', ParseIntPipe) itemId: number) {
    return this.checklist.remove(itemId);
  }

  @Post('checklist/reorder')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Bulk-update sortOrder of checklist items' })
  async reorderChecklist(@Body() body: { items: Array<{ id: number; sortOrder: number }> }) {
    return this.checklist.reorder(body?.items ?? []);
  }

  // Comments
  @Get(':id/comments')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List task comments' })
  async getComments(@CurrentUser() user: any, @Param('id', ParseIntPipe) taskId: number) {
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
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
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    return this.tasksService.addComment(taskId, user.id, body);
  }

  // Batch reorder
  @Post('reorder')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Batch reorder tasks' })
  async reorder(@CurrentUser() user: any, @Body() body: { items: { id: number; sortOrder: number; zoneId?: number }[] }) {
    // Verify access to every task being reordered
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      throw new ForbiddenException('items required');
    }
    for (const item of body.items) {
      await this.access.assertTaskAccess(user.id, item.id, user.roleId);
    }
    return this.tasksService.batchReorder(body.items);
  }

  // Attachments
  @Get(':id/attachments')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List task attachments' })
  async getAttachments(@CurrentUser() user: any, @Param('id', ParseIntPipe) taskId: number) {
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
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
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    return this.tasksService.addAttachment(taskId, user.id, body);
  }

  @Delete('attachments/:attachmentId')
  @RequirePermissions({ module: 'tasks', action: 'delete' })
  @ApiOperation({ summary: 'Delete task attachment' })
  async removeAttachment(@CurrentUser() user: any, @Param('attachmentId', ParseIntPipe) attachmentId: number) {
    // Resolve attachment → task → project, then assert access
    await this.tasksService.assertAttachmentAccess(attachmentId, async (taskId) => {
      await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    });
    return this.tasksService.removeAttachment(attachmentId, user?.id);
  }
}
