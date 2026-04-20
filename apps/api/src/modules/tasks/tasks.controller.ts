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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
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
  ) {}

  @Post()
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Create a task' })
  async create(@CurrentUser() user: any, @Body() dto: CreateTaskDto) {
    // Creating a task requires zone access (which implies project access)
    await this.access.assertZoneAccess(user.id, dto.zoneId, user.roleId);
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
    return this.tasksService.update(id, dto, user?.id);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'tasks', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a task' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertTaskAccess(user.id, id, user.roleId);
    return this.tasksService.remove(id);
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
    return this.tasksService.removeAssignee(taskId, userId);
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
    @Body() body: { content: string; parentId?: number },
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
    return this.tasksService.removeAttachment(attachmentId);
  }
}
