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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import {
  assertFinanceFieldWrites,
  canSeeFinance,
  omitKeys,
  PROJECT_MONEY_KEYS,
} from '../../common/finance/finance-access';

/** Project money a write may carry — changing it needs finance:write. */
const PROJECT_MONEY_WRITE_FIELDS = ['budget', 'estimatedValue'] as const;

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    // Branch 2 (fix/assignee-source) — the new assignee-candidates route
    // walks project-partner-roles, so it MUST gate on project access to
    // avoid IDOR (an authenticated user with projects:read could
    // otherwise enumerate any project's role holders by id).
    private readonly access: ProjectAccessService,
  ) {}

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a new project' })
  async create(@CurrentUser() user: any, @Body() dto: CreateProjectDto) {
    // Permissions round 2 — a budget / estimated value on create needs
    // finance:write; the echoed row drops project money for non-finance.
    await assertFinanceFieldWrites(user, dto, PROJECT_MONEY_WRITE_FIELDS, null);
    const project = await this.projectsService.create(user.id, dto);
    return canSeeFinance(user) ? project : omitKeys(project, PROJECT_MONEY_KEYS);
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiPaginated()
  @ApiOperation({ summary: 'List projects with filters and pagination' })
  findAll(@CurrentUser() user: any, @Query() query: QueryProjectsDto) {
    return this.projectsService.findAll(query, user.id, isAdminUser(user), user);
  }

  // Static route MUST precede `:id` so it isn't swallowed by the param route.
  @Get('number-config')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'How the project-number field should behave (auto/manual/none)' })
  numberConfig() {
    return this.projectsService.getNumberConfig();
  }

  // QA3 Commit D (Item 6d) — feeds the Contacts /contacts?view=by-project
  // grid. Returns one row per project the caller can see that has any
  // attached contact/participant, with the contact list per project (the
  // internal team + external participants + customer contacts). Static
  // route so it precedes the `:id` catch-all.
  @Get('attached-contacts')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Projects with their attached contacts, grouped for the By-Project view' })
  async getAttachedContacts(@CurrentUser() user: any) {
    return this.projectsService.getAttachedContacts(user.id, isAdminUser(user), user);
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get project by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertProjectAccess(user.id, id, isAdminUser(user));
    const project = await this.projectsService.findOne(id, user);
    // QA6 — whether the caller passes assertProjectManage (leader or
    // Admin), so the web offers leader-only actions such as assigning a
    // task to someone who is not on the Team yet.
    const canManage = await this.access.canManageProject(user, id);
    return { ...project, canManage };
  }

  // Budget + cost endpoints are gated behind the Finance module
  // permission (Item 1 / 2026-05-18). Users without finance:read get
  // a 403; admins toggle access per role via /admin/roles.
  // Round 4: finance:read sees these for every project (no access check).
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
  async update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProjectDto) {
    // Round 4: settings, leader, members and archive are leader-or-Admin;
    // the org unit (it grants the whole unit access) is Admin only.
    await this.access.assertProjectManage(user, id);
    await this.assertOrgUnitChangeAllowed(user, id, dto);
    // Permissions round 2 (B-13 / B-15) — changing budget / estimated
    // value needs finance:write (an unchanged echo passes); the response
    // drops project money for callers without finance:read.
    await assertFinanceFieldWrites(user, dto, PROJECT_MONEY_WRITE_FIELDS, () =>
      this.projectsService.getMoneySnapshot(id),
    );
    const project = await this.projectsService.update(id, dto, user?.id);
    return canSeeFinance(user) ? project : omitKeys(project, PROJECT_MONEY_KEYS);
  }

  /** Admin only when `orgUnitId` differs from the stored value; an unchanged echo passes. */
  private async assertOrgUnitChangeAllowed(user: any, id: number, dto: UpdateProjectDto): Promise<void> {
    if (dto.orgUnitId === undefined || isAdminUser(user)) return;
    const current = await this.projectsService.getOrgUnitId(id);
    if ((dto.orgUnitId ?? null) === current) return;
    throw new PermissionDeniedException("Only an administrator can change a project's organizational unit.", {
      field: 'orgUnitId',
      reason: 'ADMIN_ONLY',
    });
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a project' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    // Round 4: projects:delete (decorator) AND leader-or-Admin.
    await this.access.assertProjectManage(user, id);
    return this.projectsService.remove(id, user?.id);
  }

  // Close / Reopen — distinct from delete. Closing means "the project is
  // done"; closed projects keep all their data, stay queryable for audit
  // and reporting, but the default project-list query hides them. The UI
  // exposes a "Show closed" toggle to opt back in.
  // Round 4: close / reopen are leader-or-Admin.
  @Post(':id/close')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Close a project (stamp closedAt, keep all data)' })
  async close(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertProjectManage(user, id);
    return this.projectsService.close(id, user?.id);
  }

  @Post(':id/reopen')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Reopen a previously-closed project (clear closedAt)' })
  async reopen(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertProjectManage(user, id);
    return this.projectsService.reopen(id, user?.id);
  }

  // Members — round 4: changing the team is leader-or-Admin;
  // projects:write alone no longer adds anyone.
  @Post(':id/members')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Add member to project' })
  async addMember(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    @Body('userId', ParseIntPipe) userId: number,
    @Body('role') role?: string,
  ) {
    await this.access.assertProjectManage(user, projectId);
    return this.projectsService.addMember(projectId, userId, role);
  }

  @Get(':id/members')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List project members (login users only)' })
  async getMembers(@CurrentUser() user: any, @Param('id', ParseIntPipe) projectId: number) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
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
  async getActivityLogs(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    @Query('perPage') perPage?: number,
    @Query('page') page?: number,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    return this.projectsService.getActivityLogs(projectId, {
      perPage: Math.min(Number(perPage) || 50, 200),
      page: Math.max(Number(page) || 1, 1),
    });
  }

  @Get(':id/team')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Unified project team — internal members + external partners' })
  async getTeam(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
  ) {
    // Branch 2 (fix/assignee-source) — matched to /assignee-candidates
    // below so both project-scoped participation reads apply the same
    // access gate. `getTeam` previously relied on findOne's 404-only
    // check and would leak team composition to any authenticated user.
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    return this.projectsService.getTeam(projectId);
  }

  /**
   * Unified assignee candidate list for the task-tree assignee picker
   * and bulk-assign popover. Combines legacy ProjectMember rows with
   * every active ProjectPartnerRole (participant + role holders), deduped
   * by BusinessPartner id. Rows without a linked User are surfaced with
   * `canAssign: false` so the picker disables them with an explanation
   * rather than silently dropping them. (Branch 2 · fix/assignee-source.)
   */
  @Get(':id/assignee-candidates')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Unified assignable-candidate list (internal members + role holders)' })
  async getAssigneeCandidates(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    // QA3 Wave-3 Commit 7 (PR-028): widen the candidate set to every
    // company person who holds the given ProjectRoleType code. Picking
    // a non-member from the list then auto-adds them to the team via
    // the caller's `POST /project-partner-roles` write path (which
    // creates the participation row as a side effect).
    @Query('roleCode') roleCode?: string,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    return this.projectsService.getAssigneeCandidates(projectId, roleCode);
  }

  /** Excel export of every task on the project as a FLAT list — no
   *  zone/deliverable/service groups, no client-side filters applied.
   *  Users export from Planning when they need to slice the data in
   *  Excel. (Tier B #5, 2026-06-30.) */
  @Get(':id/tasks/export')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Export every task on the project as a flat Excel file' })
  async exportProjectTasks(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    @Res() res: Response,
  ) {
    // Permissions round 2 (B-10) — same access check as every other
    // project read (was missing: any projects:read holder could export
    // any project by id), and the file drops the money column for
    // callers without finance:read (files bypass the interceptor).
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    const { buffer, filename } = await this.projectsService.exportTasksExcel(projectId, {
      includeMoney: canSeeFinance(user),
    });
    // RFC 5987 encoded `filename*` alongside the ASCII fallback so
    // browsers correctly render Hebrew (and other non-ASCII)
    // project names in the download prompt. The ASCII `filename`
    // strips non-ASCII to keep older clients happy.
    const asciiFallback = filename.replace(/[^\x20-\x7E]+/g, '_');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    res.send(buffer);
  }

  @Delete(':id/members/:userId')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Remove member from project' })
  async removeMember(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    await this.access.assertProjectManage(user, projectId);
    return this.projectsService.removeMember(projectId, userId);
  }

  // Leader
  @Patch(':id/leader')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Set project leader' })
  async setLeader(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body('userId', ParseIntPipe) userId: number,
  ) {
    await this.access.assertProjectManage(user, id);
    const project = await this.projectsService.setLeader(id, userId);
    return canSeeFinance(user) ? project : omitKeys(project, PROJECT_MONEY_KEYS);
  }

  // Task Dependencies
  @Post('tasks/:taskId/dependencies')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Add task dependency' })
  // T1-Lag (2026-11-03) — payload gained per-edge Lag metadata (same
  // shape used on the template side). Body:
  //   {dependsOnId, lag?, lagUnit?: 'WORKING_DAYS'|'CALENDAR_DAYS', reason?}
  // Service does the heavy validation (lag in [0..365], lagUnit
  // enum, self-dep, circular). We parse `dependsOnId` by hand (no
  // dedicated pipe on a Body field) so the error message matches the
  // service-layer language instead of Nest's generic ParseIntPipe one.
  async addDependency(
    @CurrentUser() user: any,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body()
    body: {
      dependsOnId: number;
      lag?: number;
      lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS';
      reason?: string | null;
    },
  ) {
    // Round 4: access to the task's project; the service keeps both
    // tasks in that same project.
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.projectsService.addDependency(taskId, body);
  }

  // T1-Lag §1 (2026-11-10) — edit the Lag metadata on an existing
  // edge without tearing the row down and re-creating it. Body:
  //   { lag?, lagUnit?: 'WORKING_DAYS'|'CALENDAR_DAYS', reason?: string|null }
  // At least one field must be present. Service re-runs the full
  // cycle check (direct + transitive DFS) for symmetry with the add
  // path and returns `{ dependency, needsReschedule: true }` so the
  // FE can prompt "Save & update due dates".
  @Patch('tasks/:taskId/dependencies/:dependsOnId')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Patch task dependency (lag / lagUnit / reason)' })
  async patchDependency(
    @CurrentUser() user: any,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Param('dependsOnId', ParseIntPipe) dependsOnId: number,
    @Body()
    body: {
      lag?: number;
      lagUnit?: 'WORKING_DAYS' | 'CALENDAR_DAYS';
      reason?: string | null;
    },
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.projectsService.patchDependency(taskId, dependsOnId, body);
  }

  @Delete('tasks/:taskId/dependencies/:dependsOnId')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Remove task dependency' })
  async removeDependency(
    @CurrentUser() user: any,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Param('dependsOnId', ParseIntPipe) dependsOnId: number,
  ) {
    await this.access.assertTaskAccess(user.id, taskId, isAdminUser(user));
    return this.projectsService.removeDependency(taskId, dependsOnId);
  }
}
