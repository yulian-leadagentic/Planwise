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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { TasksService } from './tasks.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Create a task' })
  create(@CurrentUser() user: any, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List tasks with filters' })
  findAll(@Query() query: QueryTasksDto) {
    return this.tasksService.findAll(query);
  }

  @Get('mine')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List tasks assigned to current user' })
  findMine(@CurrentUser() user: any) {
    return this.tasksService.findMine(user.id);
  }

  @Get(':id')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'Get task by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tasksService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Update a task' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaskDto, @CurrentUser() user: any) {
    return this.tasksService.update(id, dto, user?.id);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'tasks', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a task' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.tasksService.remove(id);
  }

  // Assignees
  @Post(':id/assignees')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add assignee to task' })
  addAssignee(
    @Param('id', ParseIntPipe) taskId: number,
    @Body() body: { userId: number; role?: string; hourlyRate?: number },
    @CurrentUser() user: any,
  ) {
    return this.tasksService.addAssignee(taskId, body, user?.id);
  }

  @Delete(':id/assignees/:userId')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Remove assignee from task' })
  removeAssignee(
    @Param('id', ParseIntPipe) taskId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.tasksService.removeAssignee(taskId, userId);
  }

  // Comments
  @Get(':id/comments')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'List task comments' })
  getComments(@Param('id', ParseIntPipe) taskId: number) {
    return this.tasksService.getComments(taskId);
  }

  @Post(':id/comments')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add comment to task' })
  addComment(
    @Param('id', ParseIntPipe) taskId: number,
    @CurrentUser() user: any,
    @Body() body: { content: string; parentId?: number },
  ) {
    return this.tasksService.addComment(taskId, user.id, body);
  }

  // Batch reorder
  @Post('reorder')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Batch reorder tasks' })
  reorder(@Body() body: { items: { id: number; sortOrder: number; zoneId?: number }[] }) {
    return this.tasksService.batchReorder(body.items);
  }
}
