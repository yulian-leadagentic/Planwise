import { Body, Controller, Get, Param, Post, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';

import { ExecutionPlanningService } from './execution-planning.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { RequirePermissions, OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { EmployeeScopeService } from '../../common/services/employee-scope.service';
import { canSeeFinance } from '../../common/finance/finance-access';

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
  @RequirePermissions({ module: 'projects', action: 'read' })
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
  @RequirePermissions({ module: 'projects', action: 'read' })
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
  getMyWorkload(@CurrentUser() user: any, @Query('from') from: string, @Query('to') to: string) {
    return this.eps.getUserWorkload(user.id, from, to);
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
    return this.eps.calculateFeasibility(projectId, targetDate);
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

    // Get progress + feasibility for each project
    const projectData = await Promise.all(
      projects.map(async (p: any) => {
        const [progress, feasibility] = await Promise.all([
          this.eps.getProjectProgress(p.id),
          this.eps.calculateFeasibility(p.id).catch(() => null),
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
  // The Operations screen is a read-only aggregation. Its endpoints are
  // gated on `projects:read` so anyone who can already see a project
  // through ProjectAccessService can see the aggregation over that same
  // set. Operations is NOT its own grantable module — see
  // apps/api/prisma/seed.ts for the rationale (feat/ops-complete).

  @Get('dashboard/operations')
  @RequirePermissions({ module: 'projects', action: 'read' })
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
  // projects:read gate as the ops dashboard; `myDeptOnly` narrows to
  // the caller's department. (feat/ops-complete)
  @Get('dashboard/operations/bim-leaders')
  @RequirePermissions({ module: 'projects', action: 'read' })
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
  @RequirePermissions({ module: 'projects', action: 'read' })
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

  // Executive Review tab — capped task list (default 200) with
  // per-task ops note (the "Comment" column). totalCount is returned
  // so the UI can render "showing first N of M". (feat/ops-complete)
  @Get('dashboard/operations/executive-review')
  @RequirePermissions({ module: 'projects', action: 'read' })
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
  @RequirePermissions({ module: 'projects', action: 'write' })
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
