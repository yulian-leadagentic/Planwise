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

  @Get(':id')
  @RequirePermissions({ module: 'tasks', action: 'read' })
  @ApiOperation({ summary: 'Get task by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tasksService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Update a task' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaskDto) {
    return this.tasksService.update(id, dto);
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
  ) {
    return this.tasksService.addAssignee(taskId, body);
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

  // Plan Times
  @Post(':id/plan-times')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Add planned time for task' })
  addPlanTime(
    @Param('id', ParseIntPipe) taskId: number,
    @Body() body: { roleTitle: string; plannedHours: number },
  ) {
    return this.tasksService.addPlanTime(taskId, body);
  }

  @Delete(':id/plan-times/:planTimeId')
  @RequirePermissions({ module: 'tasks', action: 'write' })
  @ApiOperation({ summary: 'Remove planned time' })
  removePlanTime(@Param('planTimeId', ParseIntPipe) planTimeId: number) {
    return this.tasksService.removePlanTime(planTimeId);
  }
}
