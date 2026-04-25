import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  ParseIntPipe, UseGuards, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

// Map TemplateType → permission sub-module key.
const TYPE_TO_MODULE: Record<string, string> = {
  task_list: 'templates/task-catalog',
  zone: 'templates/zone',
  combined: 'templates/deliverables',
};

type Action = 'read' | 'write' | 'delete' | 'approve' | 'export';

function hasPerm(user: any, moduleKey: string, action: Action): boolean {
  if (!user?.roleModules) return false;
  if (user.role?.name === 'Admin' || user.roleName === 'Admin') return true;

  const expand = (k: string): string[] => {
    const out = [k];
    const path = k.startsWith('/') ? k : `/${k}`;
    const parts = path.split('/').filter(Boolean);
    for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join('/'));
    return out;
  };

  for (const cand of expand(moduleKey)) {
    const lc = cand.toLowerCase();
    const rm = user.roleModules.find((m: any) => {
      const r = m.module?.route || '';
      const n = m.module?.name?.toLowerCase() || '';
      return r === cand || r === `/${cand}` || n === lc;
    });
    if (!rm) continue;
    switch (action) {
      case 'read': return !!rm.canRead;
      case 'write': return !!rm.canWrite;
      case 'delete': return !!rm.canDelete;
      case 'approve': return !!rm.canApprove;
      case 'export': return !!rm.canExport;
    }
  }
  return false;
}

@ApiTags('Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  /**
   * Resolve the template's type and assert the caller has the matching
   * sub-module permission. Used for mutations on a specific template id.
   */
  private async assertByTemplateId(user: any, templateId: number, action: Action) {
    const tpl = await this.templatesService.findOne(templateId);
    if (!tpl) throw new ForbiddenException('Template not found');
    const mod = TYPE_TO_MODULE[(tpl as any).type] ?? 'templates';
    if (!hasPerm(user, mod, action)) {
      throw new ForbiddenException(`Insufficient permissions for ${mod}`);
    }
  }

  @Get()
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'List templates with optional type filter' })
  findAll(@CurrentUser() user: any, @Query('type') type?: string) {
    if (type && TYPE_TO_MODULE[type]) {
      if (!hasPerm(user, TYPE_TO_MODULE[type], 'read')) {
        throw new ForbiddenException(`Insufficient permissions for ${TYPE_TO_MODULE[type]}`);
      }
    }
    return this.templatesService.findAll(type);
  }

  @Post()
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Create a template' })
  create(@CurrentUser() user: any, @Body() body: any) {
    const mod = TYPE_TO_MODULE[body.type ?? 'task_list'] ?? 'templates';
    if (!hasPerm(user, mod, 'write')) {
      throw new ForbiddenException(`Insufficient permissions for ${mod}`);
    }
    return this.templatesService.create(user.id, body);
  }

  @Get(':id')
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Get template with tasks/zones' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertByTemplateId(user, id, 'read');
    return this.templatesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Update a template' })
  async update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    await this.assertByTemplateId(user, id, 'write');
    return this.templatesService.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Delete a template (only if usageCount=0)' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertByTemplateId(user, id, 'delete');
    return this.templatesService.remove(id);
  }

  // Template Tasks CRUD (for task_list type)
  @Post(':id/tasks')
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Add a task to a template' })
  async addTask(@CurrentUser() user: any, @Param('id', ParseIntPipe) templateId: number, @Body() body: any) {
    await this.assertByTemplateId(user, templateId, 'write');
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

  // Zone management within a template — implies zone-templates permission
  @Post(':id/zones')
  @RequirePermissions({ module: 'templates/zone', action: 'write' })
  @ApiOperation({ summary: 'Add a zone to a template' })
  addZone(@Param('id', ParseIntPipe) templateId: number, @Body() body: any) {
    return this.templatesService.addZone(templateId, body);
  }

  @Patch('zones/:zoneId')
  @RequirePermissions({ module: 'templates/zone', action: 'write' })
  @ApiOperation({ summary: 'Update a template zone' })
  updateZone(@Param('zoneId', ParseIntPipe) zoneId: number, @Body() body: any) {
    return this.templatesService.updateZone(zoneId, body);
  }

  @Delete('zones/:zoneId')
  @RequirePermissions({ module: 'templates/zone', action: 'delete' })
  @ApiOperation({ summary: 'Delete a template zone' })
  removeZone(@Param('zoneId', ParseIntPipe) zoneId: number) {
    return this.templatesService.removeZone(zoneId);
  }

  @Post('zones/:zoneId/tasks')
  @RequirePermissions({ module: 'templates/zone', action: 'write' })
  @ApiOperation({ summary: 'Add a task to a template zone' })
  addZoneTask(@Param('zoneId', ParseIntPipe) zoneId: number, @Body() body: any) {
    return this.templatesService.addZoneTask(zoneId, body);
  }

  @Delete('zone-tasks/:id')
  @RequirePermissions({ module: 'templates/zone', action: 'delete' })
  @ApiOperation({ summary: 'Delete a template zone task' })
  removeZoneTask(@Param('id', ParseIntPipe) id: number) {
    return this.templatesService.removeZoneTask(id);
  }

  @Post(':id/duplicate')
  @RequirePermissions({ module: 'templates', action: 'read' })
  @ApiOperation({ summary: 'Duplicate a template' })
  async duplicate(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: { name: string; code: string }) {
    await this.assertByTemplateId(user, id, 'write');
    return this.templatesService.duplicate(id, user.id, body);
  }
}
