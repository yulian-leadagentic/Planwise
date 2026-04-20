import { Controller, Get, Param, Query, ParseIntPipe, UseGuards, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { ExecutionPlanningService } from './execution-planning.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions, OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';

@ApiTags('Execution Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ExecutionPlanningController {
  constructor(
    private readonly eps: ExecutionPlanningService,
    private readonly access: ProjectAccessService,
  ) {}

  // ─── Workload ───────────────────────────────────────────────────────────

  @Get('workload/user/:userId')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get user workload (planned vs capacity per day)' })
  getUserWorkload(
    @CurrentUser() user: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    // Only super-admins can see arbitrary users' workload; everyone else only their own
    if (user.id !== userId && user.roleId !== 1) {
      throw new ForbiddenException('You can only view your own workload');
    }
    return this.eps.getUserWorkload(userId, from, to);
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
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.eps.getProjectWorkload(projectId, from, to);
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
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.eps.calculateFeasibility(projectId, targetDate);
  }

  @Get('projects/:id/estimated-cost')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Calculate project estimated cost from employee rates × logged hours' })
  async getEstimatedCost(@CurrentUser() user: any, @Param('id', ParseIntPipe) projectId: number) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.eps.calculateEstimatedCost(projectId);
  }

  // ─── Progress ───────────────────────────────────────────────────────────

  @Get('projects/:id/progress')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get project weighted progress' })
  async getProgress(@CurrentUser() user: any, @Param('id', ParseIntPipe) projectId: number) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.eps.getProjectProgress(projectId);
  }

  // ─── Manager Dashboard ──────────────────────────────────────────────────

  @Get('dashboard/manager')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Manager dashboard with project KPIs' })
  async getManagerDashboard(@CurrentUser() user: any) {
    // Get all projects the user is a member of
    const memberships = await this.eps['prisma'].projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const projectIds = memberships.map((m: any) => m.projectId);

    const projects = await this.eps['prisma'].project.findMany({
      where: { id: { in: projectIds }, deletedAt: null },
      include: {
        _count: { select: { tasks: true, members: true, zones: true } },
        leader: { select: { id: true, firstName: true, lastName: true } },
      },
    });

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

  @Get('dashboard/operations')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Operations dashboard — projects at risk, team load, overdue tasks' })
  async getOperationsDashboard(@CurrentUser() user: any) {
    const prisma = this.eps['prisma'];
    const now = new Date();

    // Scope to projects the caller can access
    const acc = await this.access.getAccessibleProjectIds(user.id, user.roleId);
    const projectScope = acc.all ? {} : { id: { in: acc.projectIds } };

    const activeProjects = await prisma.project.findMany({
      where: { ...projectScope, deletedAt: null, status: { in: ['active', 'on_hold'] } },
      include: {
        leader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        department: { select: { id: true, name: true } },
        _count: { select: { tasks: true, zones: true, members: true } },
      },
    });

    const projectIds = activeProjects.map((p: any) => p.id);

    const allTasks = await prisma.task.findMany({
      where: { projectId: { in: projectIds }, deletedAt: null, isArchived: false, status: { notIn: ['completed', 'cancelled'] } },
      include: {
        project: { select: { id: true, name: true, number: true } },
        zone: { select: { id: true, name: true } },
        assignees: { where: { deletedAt: null }, include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, position: true, department: true } } } },
        dependencies: { include: { dependsOn: { select: { id: true, status: true } } } },
      },
    });

    const overdueTasks = allTasks.filter((t: any) => t.endDate && new Date(t.endDate) < now);
    const overdueIds = new Set(overdueTasks.map((t: any) => t.id));

    const blockedByOverdue = allTasks.filter((t: any) =>
      t.dependencies?.some((d: any) => overdueIds.has(d.dependsOnId) || (d.dependsOn?.status && d.dependsOn.status !== 'completed'))
    );

    const budgetData = await Promise.all(activeProjects.map(async (p: any) => {
      const [taskBudget, timeLogged] = await Promise.all([
        prisma.task.aggregate({ where: { projectId: p.id, deletedAt: null, isArchived: false }, _sum: { budgetAmount: true, budgetHours: true }, _count: true }),
        prisma.timeEntry.aggregate({ where: { projectId: p.id, deletedAt: null }, _sum: { minutes: true } }),
      ]);
      return { projectId: p.id, budgetAmount: Number(taskBudget._sum.budgetAmount ?? 0), budgetHours: Number(taskBudget._sum.budgetHours ?? 0), loggedMinutes: Number(timeLogged._sum.minutes ?? 0) };
    }));
    const budgetMap = new Map(budgetData.map((b) => [b.projectId, b]));

    const projects = activeProjects.map((p: any) => {
      const bd = budgetMap.get(p.id);
      const projectOverdue = overdueTasks.filter((t: any) => t.projectId === p.id);
      const budget = Number(p.budget ?? 0);
      const budgetUsed = bd ? bd.budgetAmount : 0;
      const budgetPct = budget > 0 ? Math.round(budgetUsed / budget * 100) : 0;
      const daysLeft = p.endDate ? Math.round((new Date(p.endDate).getTime() - now.getTime()) / 86400000) : null;
      const loggedHours = bd ? Math.round(bd.loggedMinutes / 60) : 0;
      const budgetHours = bd ? bd.budgetHours : 0;
      const progressPct = budgetHours > 0 ? Math.min(100, Math.round(loggedHours / budgetHours * 100)) : 0;

      const riskFactors: { text: string; severity: string }[] = [];
      if (budgetPct > 85 && progressPct < 60) riskFactors.push({ text: `Budget ${budgetPct}% used with only ${progressPct}% progress`, severity: 'critical' });
      if (daysLeft !== null && daysLeft < 0) riskFactors.push({ text: `Deadline passed ${Math.abs(daysLeft)} days ago`, severity: 'critical' });
      if (projectOverdue.length > 3) riskFactors.push({ text: `${projectOverdue.length} overdue tasks`, severity: 'high' });

      const status = riskFactors.some((r) => r.severity === 'critical') ? 'critical'
        : (riskFactors.length > 0 || projectOverdue.length > 0) ? 'high'
        : (budgetPct > 70 || (daysLeft !== null && daysLeft < 30)) ? 'medium' : 'ok';

      return {
        id: p.id, name: p.name, number: p.number, status,
        leader: p.leader, department: p.department,
        progress: progressPct, budget, budgetUsed, budgetPct, daysLeft, riskFactors,
        overdueTasks: projectOverdue.map((t: any) => ({
          id: t.id, code: t.code, name: t.name, zone: t.zone?.name,
          assignee: t.assignees?.[0]?.user ?? null,
          hoursLeft: Number(t.budgetHours ?? 0),
          daysOverdue: Math.round((now.getTime() - new Date(t.endDate).getTime()) / 86400000),
          priority: t.priority, blockedTasks: blockedByOverdue.filter((b: any) => b.dependencies?.some((d: any) => d.dependsOnId === t.id)).length,
        })),
        blockedTasks: blockedByOverdue.filter((t: any) => t.projectId === p.id).length,
      };
    })
    .filter((p: any) => p.status !== 'ok' || p.overdueTasks.length > 0)
    .sort((a: any, b: any) => { const rank: any = { critical: 0, high: 1, medium: 2, ok: 3 }; return (rank[a.status] ?? 3) - (rank[b.status] ?? 3); });

    // Team load by department
    const employees = await prisma.user.findMany({
      where: { isActive: true, userType: { in: ['employee', 'both'] }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true, position: true, department: true, dailyStandardHours: true },
    });

    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 4); weekEnd.setHours(23, 59, 59, 999);

    const weekEntries = await prisma.timeEntry.groupBy({ by: ['userId'], where: { deletedAt: null, date: { gte: weekStart, lte: weekEnd } }, _sum: { minutes: true } });
    const hoursMap = new Map(weekEntries.map((e: any) => [e.userId, Math.round(Number(e._sum.minutes ?? 0) / 60)]));

    const taskCountByUser = await prisma.taskAssignee.groupBy({ by: ['userId'], where: { deletedAt: null, task: { deletedAt: null, status: { notIn: ['completed', 'cancelled'] } } }, _count: true });
    const taskCountMap = new Map(taskCountByUser.map((t: any) => [t.userId, t._count]));

    // Build per-member task list from allTasks
    const memberTasksMap = new Map<number, any[]>();
    for (const t of allTasks) {
      for (const a of (t.assignees ?? [])) {
        if (!memberTasksMap.has(a.userId)) memberTasksMap.set(a.userId, []);
        memberTasksMap.get(a.userId)!.push({
          id: t.id, code: t.code, name: t.name, status: t.status, priority: t.priority,
          projectId: t.projectId, projectName: t.project?.name, projectNumber: t.project?.number,
          zone: t.zone?.name, hoursLeft: Number(t.budgetHours ?? 0),
          daysOverdue: t.endDate && new Date(t.endDate) < now ? Math.round((now.getTime() - new Date(t.endDate).getTime()) / 86400000) : null,
          endDate: t.endDate,
        });
      }
    }

    const deptMap = new Map<string, any>();
    for (const emp of employees) {
      const deptName = emp.department || 'Unassigned';
      if (!deptMap.has(deptName)) deptMap.set(deptName, { name: deptName, members: [] });
      const capacity = Number(emp.dailyStandardHours ?? 8) * 5;
      const empTasks = memberTasksMap.get(emp.id) ?? [];
      deptMap.get(deptName).members.push({
        id: emp.id, firstName: emp.firstName, lastName: emp.lastName, avatarUrl: emp.avatarUrl, position: emp.position,
        hoursWeek: hoursMap.get(emp.id) ?? 0, capacity, tasks: taskCountMap.get(emp.id) ?? 0,
        overdueTasks: empTasks.filter((t: any) => t.daysOverdue !== null && t.daysOverdue > 0).length,
        taskList: empTasks,
      });
    }

    const departments = Array.from(deptMap.values()).map((d: any) => ({
      ...d,
      totalHours: d.members.reduce((s: number, m: any) => s + m.hoursWeek, 0),
      totalCapacity: d.members.reduce((s: number, m: any) => s + m.capacity, 0),
      totalOverdue: d.members.reduce((s: number, m: any) => s + m.overdueTasks, 0),
    }));

    const overloaded = employees.filter((e) => (hoursMap.get(e.id) ?? 0) > Number(e.dailyStandardHours ?? 8) * 5);
    const available = employees.filter((e) => (hoursMap.get(e.id) ?? 0) < Number(e.dailyStandardHours ?? 8) * 5 * 0.7);

    return {
      summary: {
        totalOverdue: overdueTasks.length, totalBlocked: blockedByOverdue.length,
        overloadedCount: overloaded.length, availableCount: available.length,
        availableHours: available.reduce((s, e) => s + (Number(e.dailyStandardHours ?? 8) * 5 - (hoursMap.get(e.id) ?? 0)), 0),
      },
      projects,
      departments,
    };
  }
}
