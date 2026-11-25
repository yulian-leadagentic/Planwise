import { Body, Controller, Get, Param, Post, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';

import { ExecutionPlanningService } from './execution-planning.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { RequirePermissions, OwnData, RequiredPermission } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { EmployeeScopeService } from '../../common/services/employee-scope.service';
import { canSeeFinance } from '../../common/finance/finance-access';

/**
 * QA6 P7 (PR-056, owner's decision 25.11) — Operations is its own
 * permission module (`modules.route = '/operations'`, migration
 * 20261125180000_operations_module). Every `dashboard/operations*` and
 * `workload/*` route needs `operations:read`, except `workload/me`
 * (own data). The per-project workload panel calls
 * `projects/:id/workload`, which stays on projects:read + project access.
 * Admin passes through the RolesGuard bypass like any module not in
 * NO_ADMIN_BYPASS.
 */
export const OPERATIONS_READ: RequiredPermission = { module: 'operations', action: 'read' };

@ApiTags('Execution Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ExecutionPlanningController {
  constructor(
    private readonly eps: ExecutionPlanningService,
    private readonly access: ProjectAccessService,
    private readonly employeeScope: EmployeeScopeService,
  ) {}

  // ─── Workload ───────────────────────────────────────────────────────────

  // Permissions round 3 (2026-11-22): the workload carries the person's
  // logged hours per day, so it follows the timesheet rule — self, hr:read
  // or the manager chain. Admin is no longer an exception.
  @Get('workload/user/:userId')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Get user workload (planned vs capacity per day)' })
  async getUserWorkload(
    @CurrentUser() user: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (user.id !== userId && !(await this.employeeScope.canViewEmployee(user, userId))) {
      throw new PermissionDeniedException(
        'You can only view your own workload and the workload of employees you manage.',
        { reason: 'NOT_IN_MANAGER_CHAIN' },
      );
    }
    // QA6 P3 — same engine as /workload/team; tasks on projects the
    // caller cannot open are listed as "Other project".
    const acc = await this.access.getAccessibleProjectIds(user.id, isAdminUser(user));
    const ids = new Set(acc.projectIds);
    return this.eps.getUserWorkload(userId, from, to, {
      canSeeProject: (pid) => (pid == null ? userId === user.id : acc.all || ids.has(pid)),
      // Self or canViewEmployee (checked above): his absences may show.
      absencesFor: [userId],
    });
  }

  /**
   * QA6 P3 (PR-073) — the whole team's workload in ONE call (the
   * Operations › Workload tab). Query: `from` + `to` (YYYY-MM-DD, ≤ 93
   * days) or `weekOf` (any date → its org work week; default: this
   * week), `orgUnitId` (unit + sub-units) or `myDeptOnly=true`.
   * Planned load for everyone; logged hours only for people the caller
   * may see (round 3), others `logged: null`; tasks on projects he
   * cannot open are masked. Contract: ExecutionPlanningService.getTeamWorkload.
   */
  @Get('workload/team')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Team workload — every active employee, planned vs capacity per working day, one call' })
  async getTeamWorkload(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('weekOf') weekOf?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('myDeptOnly') myDeptOnly?: string,
  ) {
    return this.eps.getTeamWorkload(
      {
        id: user.id,
        isAdmin: isAdminUser(user),
        visibleUserIds: await this.employeeScope.visibleUserIds(user),
      },
      { from, to, weekOf, orgUnitId, myDeptOnly },
    );
  }

  @Get('workload/me')
  @OwnData()
  @ApiOperation({ summary: 'Get my workload' })
  async getMyWorkload(@CurrentUser() user: any, @Query('from') from: string, @Query('to') to: string) {
    // QA6 — an assignment no longer opens a project, so a task of his on
    // a project he cannot open is masked ("Other project", hours kept),
    // exactly as on /workload/user/:self. His personal tasks stay.
    const acc = await this.access.getAccessibleProjectIds(user.id, isAdminUser(user));
    const ids = new Set(acc.projectIds);
    return this.eps.getUserWorkload(user.id, from, to, {
      canSeeProject: (pid) => pid == null || acc.all || ids.has(pid),
      absencesFor: [user.id],
    });
  }

  @Get('projects/:id/workload')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get project team workload' })
  async getProjectWorkload(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    // Round 3: logged (actual) hours only for members the caller may see.
    const visible = await this.employeeScope.visibleUserIds(user);
    // QA6 P3 — tasks of members on projects the caller can't open are masked.
    return this.eps.getProjectWorkload(projectId, from, to, visible, { id: user.id, isAdmin: isAdminUser(user) });
  }

  // ─── Feasibility ────────────────────────────────────────────────────────

  @Get('projects/:id/feasibility')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Calculate project feasibility' })
  async getFeasibility(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) projectId: number,
    @Query('targetDate') targetDate?: string,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    // QA6 — absences cut an assignee's available hours only inside the
    // caller's round-3 scope (self, hr:read, manager chain).
    return this.eps.calculateFeasibility(projectId, targetDate, await this.employeeScope.visibleUserIds(user));
  }

  // `GET /projects/:id/estimated-cost` was removed in permissions round 2
  // (B-04): it returned every member's `User.salaryHourly` (as "rate") to
  // anyone with projects:read on the project, and the web never called
  // it. The finance-gated `GET /projects/:id/labor-cost` replaces it.

  // ─── Progress ───────────────────────────────────────────────────────────

  @Get('projects/:id/progress')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get project weighted progress' })
  async getProgress(@CurrentUser() user: any, @Param('id', ParseIntPipe) projectId: number) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    return this.eps.getProjectProgress(projectId);
  }

  // ─── Manager Dashboard ──────────────────────────────────────────────────

  @Get('dashboard/manager')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Manager dashboard with project KPIs' })
  async getManagerDashboard(@CurrentUser() user: any) {
    // Round 4 — every project the access rule admits (leader, creator,
    // member, org unit, manager chain, …), not memberships only.
    const acc = await this.access.getAccessibleProjectIds(user.id, isAdminUser(user));
    const projects = await this.eps['prisma'].project.findMany({
      where: acc.all ? { deletedAt: null } : { id: { in: acc.projectIds }, deletedAt: null },
      include: {
        _count: { select: { tasks: true, members: true, zones: true } },
        leader: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const projectIds = projects.map((p: any) => p.id);
    // QA6 — feasibility reads capacity; absences only inside his scope.
    const visible = await this.employeeScope.visibleUserIds(user);

    // Get progress + feasibility for each project
    const projectData = await Promise.all(
      projects.map(async (p: any) => {
        const [progress, feasibility] = await Promise.all([
          this.eps.getProjectProgress(p.id),
          this.eps.calculateFeasibility(p.id, undefined, visible).catch(() => null),
        ]);
        return {
          project: { id: p.id, name: p.name, status: p.status, leader: p.leader },
          counts: p._count,
          progress: progress.overallProgress,
          statusCounts: progress.statusCounts,
          feasibility: feasibility?.status ?? 'UNKNOWN',
        };
      }),
    );

    // Aggregate KPIs
    const totalTasks = projectData.reduce((s, p) => s + (p.counts?.tasks ?? 0), 0);
    const overdueTasks = await this.eps['prisma'].task.count({
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        status: { notIn: ['completed', 'cancelled'] },
        endDate: { lt: new Date() },
      },
    });
    const blockedTasks = await this.eps['prisma'].task.count({
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        status: 'on_hold',
      },
    });

    return {
      projects: projectData,
      kpis: {
        totalProjects: projects.length,
        totalTasks,
        overdueTasks,
        blockedTasks,
        atRiskProjects: projectData.filter((p) => p.feasibility === 'AT_RISK').length,
        impossibleProjects: projectData.filter((p) => p.feasibility === 'IMPOSSIBLE').length,
      },
    };
  }

  // ─── Operations Dashboard ──────────────────────────────────────────────
  //
  // The Operations screen is a read-only aggregation over the projects
  // the caller can reach through ProjectAccessService. QA6 P7 (PR-056):
  // its endpoints are gated on the `operations` module (OPERATIONS_READ
  // above), granted per role in Admin › Roles. It used to ride on
  // projects:read (feat/ops-complete), so every employee got in.

  @Get('dashboard/operations')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Operations dashboard — projects at risk, team load, review queue, employees at risk, service intensity' })
  async getOperationsDashboard(
    @CurrentUser() user: any,
    // Client feedback 2026-08-02: each manager sees only their
    // department. Passing `myDeptOnly=true` restricts the employee
    // list and review queue to people whose `department` matches
    // the caller's `department`. When the caller has no department
    // set (admins), the filter no-ops and everyone is returned.
    @Query('myDeptOnly') myDeptOnly?: string,
  ) {
    // Permissions round 2 (B-11) — `canSeeFinance` decides whether the
    // at-risk rows carry budget / budgetUsed / budgetPct and the budget
    // risk factor (all of them go together).
    // Round 3 (2026-11-22) — `visibleUserIds` decides whose weekly
    // logged hours the team rows carry (others: null).
    return this.eps.getOperationsDashboard(
      {
        id: user.id,
        isAdmin: isAdminUser(user),
        canSeeFinance: canSeeFinance(user),
        visibleUserIds: await this.employeeScope.visibleUserIds(user),
      },
      myDeptOnly,
    );
  }

  // BIM Leader tab — groups accessible projects by BIM Leader with
  // per-leader counts (# active projects / # deliverables / # open
  // tasks / # overdue). Expandable to project rows. Same
  // operations:read gate as the ops dashboard; `myDeptOnly` narrows to
  // the caller's department. (feat/ops-complete)
  @Get('dashboard/operations/bim-leaders')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Operations dashboard — workload grouped by BIM Leader' })
  async getBimLeaderDashboard(
    @CurrentUser() user: any,
    @Query('myDeptOnly') myDeptOnly?: string,
  ) {
    return this.eps.getBimLeaderDashboard(
      { id: user.id, isAdmin: isAdminUser(user) },
      myDeptOnly,
    );
  }

  // Active Projects tab — flags each accessible project ACTIVE or
  // DORMANT based on upcoming due tasks + last 14d activity (time
  // entries + activity logs). (feat/ops-complete)
  @Get('dashboard/operations/active-projects')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Operations dashboard — active/dormant projects (activity model)' })
  async getActiveProjectsDashboard(
    @CurrentUser() user: any,
    @Query('myDeptOnly') myDeptOnly?: string,
  ) {
    return this.eps.getActiveProjectsDashboard(
      { id: user.id, isAdmin: isAdminUser(user) },
      myDeptOnly,
    );
  }

  // Executive Review tab — EVERY open task in scope (QA6 PR-080: the
  // 200-row cap is gone; `take` only narrows) with the per-task ops note
  // (the "Comment" column) and totalCount / truncated. (feat/ops-complete)
  @Get('dashboard/operations/executive-review')
  @RequirePermissions(OPERATIONS_READ)
  @ApiOperation({ summary: 'Operations dashboard — executive review task list with per-task ops note' })
  async getExecutiveReview(
    @CurrentUser() user: any,
    @Query('myDeptOnly') myDeptOnly?: string,
    @Query('take') take?: string,
  ) {
    return this.eps.getExecutiveReview(
      { id: user.id, isAdmin: isAdminUser(user) },
      myDeptOnly,
      take,
    );
  }

  // Persist / clear a per-task ops note (Executive Review Comment
  // column). Empty content clears the note. Access is checked via
  // ProjectAccessService inside the service. Requires projects:write
  // — the note is scoped to the same audience that can edit project
  // data. (feat/ops-complete)
  @Post('dashboard/operations/tasks/:taskId/ops-note')
  @RequirePermissions(OPERATIONS_READ, { module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Upsert (or clear when content is empty) the Executive Review ops note for a task' })
  @ApiBody({ schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } })
  async upsertOpsNote(
    @CurrentUser() user: any,
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body('content') content?: string,
  ) {
    return this.eps.upsertTaskOpsNote(
      { id: user.id, isAdmin: isAdminUser(user) },
      taskId,
      content ?? '',
    );
  }

}
