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

import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a new project' })
  create(@CurrentUser() user: any, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(user.id, dto);
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List projects with filters and pagination' })
  findAll(@CurrentUser() user: any, @Query() query: QueryProjectsDto) {
    return this.projectsService.findAll(query, user.id, user.roleId, user);
  }

  // Static route MUST precede `:id` so it isn't swallowed by the param route.
  @Get('number-config')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'How the project-number field should behave (auto/manual/none)' })
  numberConfig() {
    return this.projectsService.getNumberConfig();
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get project by ID' })
  findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.projectsService.findOne(id, user);
  }

  // Budget + cost endpoints are gated behind the Finance module
  // permission (Item 1 / 2026-05-18). Users without finance:read get
  // a 403; admins toggle access per role via /admin/roles.
  @Get(':id/budget-summary')
  @RequirePermissions({ module: 'finance', action: 'read' })
  @ApiOperation({ summary: 'Get budget summary for project (requires finance:read)' })
  getBudgetSummary(@Param('id', ParseIntPipe) id: number) {
    return this.projectsService.getBudgetSummary(id);
  }

  // M5 — Labor cost rollup. Gated by finance:read (cost data is
  // sensitive). Returns per-user breakdown, per-currency totals, and a
  // separate "unrateable" bucket for users whose seniority isn't set /
  // has no hourly cost — surfaced so admins see the data gap rather
  // than silently zero-bucketed.
  @Get(':id/labor-cost')
  @RequirePermissions({ module: 'finance', action: 'read' })
  @ApiOperation({ summary: 'Labor cost rollup from logged time × seniority hourly cost (requires finance:read)' })
  getLaborCost(@Param('id', ParseIntPipe) id: number) {
    return this.projectsService.getLaborCost(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Update a project' })
  update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(id, dto, user?.id);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a project' })
  remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.projectsService.remove(id, user?.id);
  }

  // Close / Reopen — distinct from delete. Closing means "the project is
  // done"; closed projects keep all their data, stay queryable for audit
  // and reporting, but the default project-list query hides them. The UI
  // exposes a "Show closed" toggle to opt back in.
  @Post(':id/close')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Close a project (stamp closedAt, keep all data)' })
  close(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.projectsService.close(id, user?.id);
  }

  @Post(':id/reopen')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Reopen a previously-closed project (clear closedAt)' })
  reopen(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.projectsService.reopen(id, user?.id);
  }

  // Members
  @Post(':id/members')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Add member to project' })
  addMember(
    @Param('id', ParseIntPipe) projectId: number,
    @Body('userId', ParseIntPipe) userId: number,
    @Body('role') role?: string,
  ) {
    return this.projectsService.addMember(projectId, userId, role);
  }

  @Get(':id/members')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List project members (login users only)' })
  getMembers(@Param('id', ParseIntPipe) projectId: number) {
    return this.projectsService.getMembers(projectId);
  }

  // Project Activity feed — surfaces every audited write that
  // ActivityLogService routed to this project (status changes, assignee
  // adds, member changes, file events, etc.). Permission stays at
  // projects:read because the same people who can see the project
  // already see the data this aggregates.
  @Get(':id/activity-logs')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List activity-log entries scoped to this project (latest first)' })
  getActivityLogs(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('perPage') perPage?: number,
    @Query('page') page?: number,
  ) {
    return this.projectsService.getActivityLogs(projectId, {
      perPage: Math.min(Number(perPage) || 50, 200),
      page: Math.max(Number(page) || 1, 1),
    });
  }

  @Get(':id/team')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Unified project team — internal members + external partners' })
  getTeam(@Param('id', ParseIntPipe) projectId: number) {
    return this.projectsService.getTeam(projectId);
  }

  @Delete(':id/members/:userId')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Remove member from project' })
  removeMember(
    @Param('id', ParseIntPipe) projectId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.projectsService.removeMember(projectId, userId);
  }

  // Leader
  @Patch(':id/leader')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Set project leader' })
  setLeader(@Param('id', ParseIntPipe) id: number, @Body('userId', ParseIntPipe) userId: number) {
    return this.projectsService.setLeader(id, userId);
  }

  // Task Dependencies
  @Post('tasks/:taskId/dependencies')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Add task dependency' })
  addDependency(@Param('taskId', ParseIntPipe) taskId: number, @Body('dependsOnId', ParseIntPipe) dependsOnId: number) {
    return this.projectsService.addDependency(taskId, dependsOnId);
  }

  @Delete('tasks/:taskId/dependencies/:dependsOnId')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Remove task dependency' })
  removeDependency(@Param('taskId', ParseIntPipe) taskId: number, @Param('dependsOnId', ParseIntPipe) dependsOnId: number) {
    return this.projectsService.removeDependency(taskId, dependsOnId);
  }
}
