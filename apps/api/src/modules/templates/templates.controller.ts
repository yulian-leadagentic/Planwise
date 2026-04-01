import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  ParseIntPipe, UseGuards, Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'List templates with optional type filter' })
  findAll(@Query('type') type?: string) {
    return this.templatesService.findAll(type);
  }

  @Post()
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Create a template' })
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.templatesService.create(user.id, body);
  }

  @Get(':id')
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Get template with tasks/zones' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.templatesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Update a template' })
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.templatesService.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'templates', action: 'delete' })
  @ApiOperation({ summary: 'Delete a template (only if usageCount=0)' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.templatesService.remove(id);
  }

  // Template Tasks CRUD (for task_list type)
  @Post(':id/tasks')
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Add a task to a template' })
  addTask(@Param('id', ParseIntPipe) templateId: number, @Body() body: any) {
    return this.templatesService.addTask(templateId, body);
  }

  @Patch('tasks/:taskId')
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Update a template task' })
  updateTask(@Param('taskId', ParseIntPipe) taskId: number, @Body() body: any) {
    return this.templatesService.updateTask(taskId, body);
  }

  @Delete('tasks/:taskId')
  @RequirePermissions({ module: 'templates', action: 'delete' })
  @ApiOperation({ summary: 'Delete a template task' })
  removeTask(@Param('taskId', ParseIntPipe) taskId: number) {
    return this.templatesService.removeTask(taskId);
  }

  @Post(':id/duplicate')
  @RequirePermissions({ module: 'templates', action: 'write' })
  @ApiOperation({ summary: 'Duplicate a template' })
  duplicate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any, @Body() body: { name: string; code: string }) {
    return this.templatesService.duplicate(id, user.id, body);
  }
}
