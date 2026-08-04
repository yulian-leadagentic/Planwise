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

import { ProjectDeliverablesService } from './project-deliverables.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { CreateProjectDeliverableDto } from './dto/create-project-deliverable.dto';
import { UpdateProjectDeliverableDto } from './dto/update-project-deliverable.dto';
import { ReorderProjectDeliverablesDto } from './dto/reorder-project-deliverables.dto';

@ApiTags('Project Deliverables')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('project-deliverables')
export class ProjectDeliverablesController {
  constructor(
    private readonly service: ProjectDeliverablesService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List a project\'s deliverables (ordered)' })
  async findAll(
    @CurrentUser() user: any,
    @Query('projectId', ParseIntPipe) projectId: number,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.findAllForProject(projectId);
  }

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a project deliverable' })
  async create(@CurrentUser() user: any, @Body() dto: CreateProjectDeliverableDto) {
    await this.access.assertProjectAccess(user.id, dto.projectId, user.roleId);
    return this.service.create(dto);
  }

  @Post('reorder')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Batch reorder project deliverables' })
  async reorder(@CurrentUser() user: any, @Body() dto: ReorderProjectDeliverablesDto) {
    if (!Array.isArray(dto?.items) || dto.items.length === 0) return { updated: 0 };
    for (const it of dto.items) {
      const projectId = await this.service.getProjectId(it.id);
      await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    }
    return this.service.reorder(dto);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Update a project deliverable (rename/reorder/status)' })
  async update(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDeliverableDto,
  ) {
    const projectId = await this.service.getProjectId(id);
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.update(id, dto);
  }

  /** Deliverable Planning target date (Tier E #10).
   *  Body: { months: number | null }
   *   - months=null clears the target
   *   - months>=0 → compute base+N months, then snap to the FIRST DAY
   *     of the week (Monday, ISO) that computed date falls in.
   *  Persisted on ProjectDeliverable.targetDate + targetMonths. */
  @Patch(':id/target')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Set the Deliverable Planning target date (months-from-base, Sunday-forward snap). Optional zoneId scopes the target to a (zone × deliverable) pair.' })
  async setTarget(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { months: number | null; baseDate?: string; zoneId?: number; durationWeeks?: number | null },
  ) {
    const projectId = await this.service.getProjectId(id);
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.setTarget(id, body.months, body.baseDate, body.zoneId, body.durationWeeks);
  }

  /** Batch save target dates for the Deliverable Planning UI. Items
   *  may be deliverable-level (no zoneId) OR per-zone. Auto-propagates
   *  to task due dates unless applyToTasks=false; returns any tasks
   *  the caller MUST decide about (manually overridden ones).
   *  Body: { baseDate?, applyToTasks?, items: [{ id, months, zoneId? }] } */
  @Post('targets/batch')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Batch-save Deliverable Planning target dates + auto-propagate to task due dates' })
  async batchTargets(
    @CurrentUser() user: any,
    @Body() body: { baseDate?: string; applyToTasks?: boolean; items: { id: number; months: number | null; zoneId?: number | null; durationWeeks?: number | null; targetDate?: string | null }[] },
  ) {
    if (!Array.isArray(body?.items) || body.items.length === 0) return { updated: 0, overriddenTasks: [] };
    for (const it of body.items) {
      const projectId = await this.service.getProjectId(it.id);
      await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    }
    return this.service.batchSetTargets(body.items, body.baseDate, body.applyToTasks !== false, user.id);
  }

  /** Force-overwrite a task's manually-set due date with the current
   *  deliverable target date. Called after the PM confirms the
   *  "overwrite manual dates" prompt raised by batchTargets. */
  @Post('tasks/:taskId/force-apply-target')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Force-overwrite a task manual due date with the current deliverable target' })
  async forceApplyTargetToTask(
    @CurrentUser() user: any,
    @Param('taskId', ParseIntPipe) taskId: number,
  ) {
    void user;
    return this.service.forceApplyTargetToTask(taskId);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a project deliverable' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    const projectId = await this.service.getProjectId(id);
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.remove(id);
  }
}
