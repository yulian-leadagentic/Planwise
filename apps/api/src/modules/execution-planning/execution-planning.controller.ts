import { Controller, Get, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { ExecutionPlanningService } from './execution-planning.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Execution Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ExecutionPlanningController {
  constructor(private readonly eps: ExecutionPlanningService) {}

  // ─── Workload ───────────────────────────────────────────────────────────

  @Get('workload/user/:userId')
  @ApiOperation({ summary: 'Get user workload (planned vs capacity per day)' })
  getUserWorkload(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.eps.getUserWorkload(userId, from, to);
  }

  @Get('workload/me')
  @ApiOperation({ summary: 'Get my workload' })
  getMyWorkload(@CurrentUser() user: any, @Query('from') from: string, @Query('to') to: string) {
    return this.eps.getUserWorkload(user.id, from, to);
  }

  @Get('projects/:id/workload')
  @ApiOperation({ summary: 'Get project team workload' })
  getProjectWorkload(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.eps.getProjectWorkload(projectId, from, to);
  }

  // ─── Feasibility ────────────────────────────────────────────────────────

  @Get('projects/:id/feasibility')
  @ApiOperation({ summary: 'Calculate project feasibility' })
  getFeasibility(
    @Param('id', ParseIntPipe) projectId: number,
    @Query('targetDate') targetDate?: string,
  ) {
    return this.eps.calculateFeasibility(projectId, targetDate);
  }

  // ─── Progress ───────────────────────────────────────────────────────────

  @Get('projects/:id/progress')
  @ApiOperation({ summary: 'Get project weighted progress' })
  getProgress(@Param('id', ParseIntPipe) projectId: number) {
    return this.eps.getProjectProgress(projectId);
  }

  // ─── Manager Dashboard ──────────────────────────────────────────────────

  @Get('dashboard/manager')
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
}
