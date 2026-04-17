import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Workload Engine — computes planned vs capacity per worker per day.
 * Feasibility Engine — determines if a project/milestone is achievable.
 * Progress Engine — weighted progress rollup.
 * Alert Detection — scheduled checks for overdue/overload/blocked.
 */
@Injectable()
export class ExecutionPlanningService {
  private readonly logger = new Logger(ExecutionPlanningService.name);

  constructor(private prisma: PrismaService) {}

  // ─── WORKLOAD ENGINE ────────────────────────────────────────────────────

  async getUserWorkload(userId: number, from: string, to: string) {
    const startDate = new Date(from);
    const endDate = new Date(to);

    // Get user's work schedules
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        userId,
        isActive: true,
        effectiveFrom: { lte: endDate },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: startDate } }],
      },
    });

    // Get calendar days (holidays/off-days) in range
    const calendarDays = await this.prisma.calendarDay.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
        appliesTo: { in: ['all', 'employees_only'] },
      },
    });
    const holidayDates = new Set(calendarDays.map((d) => d.date.toISOString().split('T')[0]));

    // Get tasks assigned to this user with overlapping dates
    const assignments = await this.prisma.taskAssignee.findMany({
      where: {
        userId,
        deletedAt: null,
        task: {
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['completed', 'cancelled'] },
        },
      },
      include: {
        task: {
          select: {
            id: true, name: true, code: true, budgetHours: true,
            startDate: true, endDate: true, status: true, projectId: true,
          },
        },
      },
    });

    // Get actual time entries for the period
    const timeEntries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        deletedAt: null,
        date: { gte: startDate, lte: endDate },
      },
      select: { date: true, minutes: true, taskId: true },
    });

    // Build daily data
    const dailyData: Array<{
      date: string;
      dayOfWeek: number;
      capacityHours: number;
      plannedHours: number;
      actualHours: number;
      utilizationPct: number;
      isHoliday: boolean;
      tasks: Array<{ taskId: number; taskName: string; hours: number }>;
    }> = [];

    const current = new Date(startDate);
    while (current <= endDate) {
      const dateStr = current.toISOString().split('T')[0];
      const dayOfWeek = current.getDay();
      const isHoliday = holidayDates.has(dateStr);
      const isWeekend = dayOfWeek === 5 || dayOfWeek === 6; // Fri + Sat (Israel)

      // Calculate capacity
      let capacityHours = 0;
      if (!isHoliday && !isWeekend) {
        const schedule = schedules.find((s) => s.dayOfWeek === dayOfWeek);
        if (schedule) {
          const [startH, startM] = schedule.shiftStart.split(':').map(Number);
          const [endH, endM] = schedule.shiftEnd.split(':').map(Number);
          const totalMinutes = (endH * 60 + endM) - (startH * 60 + startM) - schedule.breakMinutes;
          capacityHours = Math.max(0, totalMinutes / 60);
        } else {
          capacityHours = 8; // Default 8h workday
        }
      }

      // Calculate planned hours (distribute task hours across working days)
      let plannedHours = 0;
      const taskBreakdown: Array<{ taskId: number; taskName: string; hours: number }> = [];

      for (const assignment of assignments) {
        const task = assignment.task;
        if (!task.budgetHours || Number(task.budgetHours) === 0) continue;

        const taskStart = task.startDate ? new Date(task.startDate) : startDate;
        const taskEnd = task.endDate ? new Date(task.endDate) : endDate;

        if (current < taskStart || current > taskEnd) continue;
        if (isHoliday || isWeekend) continue;

        // Count working days in task range
        const workingDays = this.countWorkingDays(taskStart, taskEnd, holidayDates);
        if (workingDays === 0) continue;

        const dailyHours = Number(task.budgetHours) / workingDays;
        plannedHours += dailyHours;
        taskBreakdown.push({ taskId: task.id, taskName: task.name, hours: Math.round(dailyHours * 100) / 100 });
      }

      // Calculate actual hours from time entries
      const dayEntries = timeEntries.filter((e) => e.date.toISOString().split('T')[0] === dateStr);
      const actualHours = dayEntries.reduce((sum, e) => sum + e.minutes / 60, 0);

      const utilizationPct = capacityHours > 0 ? Math.round((plannedHours / capacityHours) * 100) : 0;

      dailyData.push({
        date: dateStr,
        dayOfWeek,
        capacityHours: Math.round(capacityHours * 100) / 100,
        plannedHours: Math.round(plannedHours * 100) / 100,
        actualHours: Math.round(actualHours * 100) / 100,
        utilizationPct,
        isHoliday,
        tasks: taskBreakdown,
      });

      current.setDate(current.getDate() + 1);
    }

    const summary = {
      totalPlanned: Math.round(dailyData.reduce((s, d) => s + d.plannedHours, 0) * 100) / 100,
      totalCapacity: Math.round(dailyData.reduce((s, d) => s + d.capacityHours, 0) * 100) / 100,
      totalActual: Math.round(dailyData.reduce((s, d) => s + d.actualHours, 0) * 100) / 100,
      overloadedDays: dailyData.filter((d) => d.utilizationPct > 100).length,
      avgUtilization: dailyData.length > 0
        ? Math.round(dailyData.reduce((s, d) => s + d.utilizationPct, 0) / dailyData.filter((d) => d.capacityHours > 0).length)
        : 0,
    };

    return { dailyData, summary };
  }

  async getProjectWorkload(projectId: number, from: string, to: string) {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, firstName: true, lastName: true, position: true } } },
    });

    const workloads = await Promise.all(
      members.map(async (m) => ({
        user: m.user,
        role: m.role,
        workload: await this.getUserWorkload(m.userId, from, to),
      })),
    );

    return { projectId, members: workloads };
  }

  // ─── FEASIBILITY ENGINE ─────────────────────────────────────────────────

  async calculateFeasibility(projectId: number, targetDate?: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, name: true, endDate: true, budget: true },
    });

    const target = targetDate ? new Date(targetDate) : project.endDate ? new Date(project.endDate) : null;
    const now = new Date();

    // Get all incomplete tasks
    const tasks = await this.prisma.task.findMany({
      where: {
        projectId,
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['completed', 'cancelled'] },
      },
      include: {
        assignees: {
          where: { deletedAt: null },
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
        dependencies: { include: { dependsOn: { select: { id: true, status: true, endDate: true } } } },
      },
    });

    if (tasks.length === 0) {
      return { status: 'OK' as const, details: { overloadedAssignees: [], hoursDeficit: 0, criticalPathDays: 0, daysRemaining: target ? this.daysBetween(now, target) : 0, bottleneckTasks: [], unassignedTasks: [], blockedTasks: [] } };
    }

    const daysRemaining = target ? this.daysBetween(now, target) : 365;

    // Get logged time per task
    const timeAgg = await this.prisma.timeEntry.groupBy({
      by: ['taskId'],
      where: { projectId, deletedAt: null, taskId: { in: tasks.map((t) => t.id) } },
      _sum: { minutes: true },
    });
    const loggedByTask = new Map<number, number>();
    for (const row of timeAgg) {
      if (row.taskId) loggedByTask.set(row.taskId, (row._sum.minutes ?? 0) / 60);
    }

    // Check each assignee's capacity
    const assigneeLoad = new Map<number, { name: string; required: number; capacity: number }>();
    const unassignedTasks: Array<{ taskId: number; title: string; hours: number }> = [];
    const blockedTasks: Array<{ taskId: number; title: string; blockedBy: string[] }> = [];

    for (const task of tasks) {
      const budgetHours = Number(task.budgetHours || 0);
      const loggedHours = loggedByTask.get(task.id) ?? 0;
      const remainingHours = Math.max(0, budgetHours - loggedHours);

      // Check if task is blocked (all dependencies must be completed)
      const blockers = (task.dependencies || [])
        .filter((d) => d.dependsOn && d.dependsOn.status !== 'completed')
        .map((d) => d.dependsOn?.id ? `Task #${d.dependsOn.id}` : 'Unknown');
      if (blockers.length > 0) {
        blockedTasks.push({ taskId: task.id, title: task.name, blockedBy: blockers });
      }

      if (task.assignees.length === 0 && remainingHours > 0) {
        unassignedTasks.push({ taskId: task.id, title: task.name, hours: remainingHours });
        continue;
      }

      const hoursPerAssignee = remainingHours / Math.max(1, task.assignees.length);
      for (const a of task.assignees) {
        const userId = a.user.id;
        if (!assigneeLoad.has(userId)) {
          assigneeLoad.set(userId, { name: `${a.user.firstName} ${a.user.lastName}`, required: 0, capacity: 0 });
        }
        assigneeLoad.get(userId)!.required += hoursPerAssignee;
      }
    }

    // Calculate capacity for each assignee
    const fromStr = now.toISOString().split('T')[0];
    const toStr = target ? target.toISOString().split('T')[0] : new Date(now.getTime() + 365 * 86400000).toISOString().split('T')[0];

    const overloadedAssignees: Array<{ userId: number; name: string; requiredHours: number; availableHours: number; deficit: number }> = [];

    for (const [userId, load] of assigneeLoad.entries()) {
      const workload = await this.getUserWorkload(userId, fromStr, toStr);
      load.capacity = workload.summary.totalCapacity;

      if (load.required > load.capacity) {
        overloadedAssignees.push({
          userId,
          name: load.name,
          requiredHours: Math.round(load.required * 10) / 10,
          availableHours: Math.round(load.capacity * 10) / 10,
          deficit: Math.round((load.required - load.capacity) * 10) / 10,
        });
      }
    }

    const totalRequired = [...assigneeLoad.values()].reduce((s, l) => s + l.required, 0);
    const totalCapacity = [...assigneeLoad.values()].reduce((s, l) => s + l.capacity, 0);
    const hoursDeficit = Math.max(0, totalRequired - totalCapacity);

    // Calculate critical path (longest chain of dependencies in days)
    const criticalPathDays = this.calculateCriticalPath(tasks);

    // Determine status
    let status: 'OK' | 'AT_RISK' | 'IMPOSSIBLE' = 'OK';
    if (overloadedAssignees.length > 0 || criticalPathDays > daysRemaining) {
      status = 'IMPOSSIBLE';
    } else if (
      hoursDeficit > 0 ||
      criticalPathDays > daysRemaining * 0.85 ||
      unassignedTasks.length > tasks.length * 0.3 ||
      blockedTasks.length > tasks.length * 0.3
    ) {
      status = 'AT_RISK';
    }

    return {
      status,
      details: {
        overloadedAssignees,
        hoursDeficit: Math.round(hoursDeficit * 10) / 10,
        criticalPathDays,
        daysRemaining,
        bottleneckTasks: overloadedAssignees.length > 0
          ? tasks.filter((t) => t.assignees.some((a) => overloadedAssignees.some((o) => o.userId === a.userId)))
              .slice(0, 5).map((t) => ({ taskId: t.id, title: t.name }))
          : [],
        unassignedTasks,
        blockedTasks,
      },
    };
  }

  // ─── PROGRESS ENGINE ────────────────────────────────────────────────────

  async getProjectProgress(projectId: number) {
    const tasks = await this.prisma.task.findMany({
      where: { projectId, deletedAt: null, isArchived: false },
      select: {
        id: true, name: true, status: true, budgetHours: true, completionPct: true,
        zoneId: true, phaseId: true,
        zone: { select: { id: true, name: true } },
        phase: { select: { id: true, name: true } },
      },
    });

    // Weighted progress: SUM(completionPct * budgetHours) / SUM(budgetHours)
    const totalHours = tasks.reduce((s, t) => s + Number(t.budgetHours || 0), 0);
    const weightedProgress = totalHours > 0
      ? Math.round(tasks.reduce((s, t) => s + (t.completionPct * Number(t.budgetHours || 0)), 0) / totalHours)
      : 0;

    // Status breakdown
    const statusCounts: Record<string, number> = {};
    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // Per-zone progress
    const zoneMap = new Map<number, { name: string; totalHours: number; weightedSum: number; count: number }>();
    for (const t of tasks) {
      if (!t.zone) continue;
      if (!zoneMap.has(t.zoneId)) zoneMap.set(t.zoneId, { name: t.zone.name, totalHours: 0, weightedSum: 0, count: 0 });
      const z = zoneMap.get(t.zoneId)!;
      z.totalHours += Number(t.budgetHours || 0);
      z.weightedSum += t.completionPct * Number(t.budgetHours || 0);
      z.count++;
    }

    const zoneProgress = [...zoneMap.entries()].map(([id, z]) => ({
      zoneId: id,
      zoneName: z.name,
      taskCount: z.count,
      progress: z.totalHours > 0 ? Math.round(z.weightedSum / z.totalHours) : 0,
    }));

    return {
      overallProgress: weightedProgress,
      totalTasks: tasks.length,
      statusCounts,
      zoneProgress,
    };
  }

  // ─── ALERT DETECTION ────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async checkOverdueTasks() {
    this.logger.log('Running overdue task check...');
    const now = new Date();
    const overdueTasks = await this.prisma.task.findMany({
      where: {
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['completed', 'cancelled'] },
        endDate: { lt: now },
      },
      include: {
        assignees: { where: { deletedAt: null }, select: { userId: true } },
        project: { select: { name: true } },
      },
    });

    for (const task of overdueTasks) {
      const userIds = task.assignees.map((a) => a.userId);
      if (userIds.length === 0) continue;

      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          type: 'alert:overdue',
          title: `Task overdue: "${task.name}"`,
          body: `Task in project "${task.project.name}" was due ${task.endDate?.toLocaleDateString()}`,
          entityType: 'task',
          entityId: task.id,
        })),
        skipDuplicates: true,
      });
    }

    this.logger.log(`Found ${overdueTasks.length} overdue tasks`);
  }

  // ─── ESTIMATED COST (employee rate × actual hours) ────────────────────

  async calculateEstimatedCost(projectId: number) {
    // Get all time entries for the project with user salary
    const entries = await this.prisma.timeEntry.findMany({
      where: { projectId, deletedAt: null },
      select: {
        userId: true,
        minutes: true,
        isBillable: true,
        user: { select: { id: true, firstName: true, lastName: true, salaryHourly: true } },
      },
    });

    // Group by user
    const userCosts = new Map<number, { name: string; hours: number; rate: number; cost: number; billableHours: number }>();

    for (const e of entries) {
      const uid = e.userId;
      if (!userCosts.has(uid)) {
        const rate = e.user.salaryHourly ? Number(e.user.salaryHourly) : 0;
        userCosts.set(uid, {
          name: `${e.user.firstName} ${e.user.lastName}`,
          hours: 0, rate, cost: 0, billableHours: 0,
        });
      }
      const uc = userCosts.get(uid)!;
      const hours = e.minutes / 60;
      uc.hours += hours;
      uc.cost += hours * uc.rate;
      if (e.isBillable) uc.billableHours += hours;
    }

    const breakdown = [...userCosts.values()].map((uc) => ({
      ...uc,
      hours: Math.round(uc.hours * 100) / 100,
      cost: Math.round(uc.cost * 100) / 100,
      billableHours: Math.round(uc.billableHours * 100) / 100,
    }));

    const totalCost = Math.round(breakdown.reduce((s, b) => s + b.cost, 0) * 100) / 100;
    const totalHours = Math.round(breakdown.reduce((s, b) => s + b.hours, 0) * 100) / 100;
    const billableHours = Math.round(breakdown.reduce((s, b) => s + b.billableHours, 0) * 100) / 100;

    return { totalCost, totalHours, billableHours, breakdown };
  }

  @Cron(CronExpression.EVERY_DAY_AT_10AM)
  async checkMissingTimeReports() {
    this.logger.log('Running missing time report check...');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dayOfWeek = yesterday.getDay();

    // Skip weekends (Fri=5, Sat=6 in Israel)
    if (dayOfWeek === 5 || dayOfWeek === 6) return;

    const yesterdayStart = new Date(yesterday.toISOString().split('T')[0]);
    const yesterdayEnd = new Date(yesterdayStart.getTime() + 86400000);

    // Find active users who have task assignments but no time entries yesterday
    const usersWithAssignments = await this.prisma.taskAssignee.findMany({
      where: { deletedAt: null },
      select: { userId: true },
      distinct: ['userId'],
    });

    const entriesYesterday = await this.prisma.timeEntry.findMany({
      where: { date: { gte: yesterdayStart, lt: yesterdayEnd }, deletedAt: null },
      select: { userId: true },
      distinct: ['userId'],
    });
    const usersWithEntries = new Set(entriesYesterday.map((e) => e.userId));

    const missingUsers = usersWithAssignments.filter((u) => !usersWithEntries.has(u.userId));

    for (const u of missingUsers) {
      await this.prisma.notification.create({
        data: {
          userId: u.userId,
          type: 'alert:missing_time',
          title: 'Missing time report',
          body: `You did not log any time for ${yesterday.toLocaleDateString()}`,
        },
      });
    }

    this.logger.log(`Found ${missingUsers.length} users missing time reports`);
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────

  private countWorkingDays(from: Date, to: Date, holidays: Set<string>): number {
    let count = 0;
    const current = new Date(from);
    while (current <= to) {
      const day = current.getDay();
      const dateStr = current.toISOString().split('T')[0];
      if (day !== 5 && day !== 6 && !holidays.has(dateStr)) count++;
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  private daysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86400000));
  }

  private calculateCriticalPath(tasks: any[]): number {
    // Build adjacency list from dependencies
    const taskMap = new Map<number, any>();
    for (const t of tasks) taskMap.set(t.id, t);

    // Find longest path using DFS with memoization
    const memo = new Map<number, number>();

    const dfs = (taskId: number): number => {
      if (memo.has(taskId)) return memo.get(taskId)!;
      const task = taskMap.get(taskId);
      if (!task) return 0;

      const hours = Number(task.budgetHours || 0);
      const days = hours / 8; // 8h per working day

      let maxDep = 0;
      for (const dep of (task.dependencies || [])) {
        if (dep.dependsOnId && taskMap.has(dep.dependsOnId)) {
          maxDep = Math.max(maxDep, dfs(dep.dependsOnId));
        }
      }

      const total = days + maxDep;
      memo.set(taskId, total);
      return total;
    };

    let maxPath = 0;
    for (const t of tasks) {
      maxPath = Math.max(maxPath, dfs(t.id));
    }

    return Math.ceil(maxPath);
  }
}
