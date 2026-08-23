import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';

/**
 * Workload Engine — computes planned vs capacity per worker per day.
 * Feasibility Engine — determines if a project/milestone is achievable.
 * Progress Engine — weighted progress rollup.
 * Alert Detection — scheduled checks for overdue/overload/blocked.
 */
@Injectable()
export class ExecutionPlanningService {
  private readonly logger = new Logger(ExecutionPlanningService.name);

  constructor(
    private prisma: PrismaService,
    private access: ProjectAccessService,
  ) {}

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
    // Personal tasks are EXCLUDED from the progress rollup — per
    // spec (Tier D #1) they don't affect any deliverable's or
    // project's completion %. Hours still count in time reports
    // (aggregated elsewhere from time_entries directly), but a
    // person's own to-do list shouldn't drag a project's
    // completion bar around.
    const tasks = await this.prisma.task.findMany({
      where: { projectId, deletedAt: null, isArchived: false, isPersonal: false },
      select: {
        id: true, name: true, status: true, budgetHours: true, completionPct: true,
        zoneId: true, phaseId: true,
        zone: { select: { id: true, name: true } },
        phase: { select: { id: true, name: true } },
      },
    });

    // Weighted progress: SUM(completionPct * budgetHours) / SUM(budgetHours).
    // Fallback (PR-014): when a bucket has zero total budget hours — e.g.
    // every task is Done but nobody filled in a budget — the weighted
    // formula collapses to 0/0 and silently drops the whole bucket to 0.
    // Fall back to a simple average of completionPct across those tasks
    // so a bucket of Done tasks reads 100%, not 0%. task.completionPct is
    // already status-aware (completed/cancelled → 100 per
    // time-entries.service#syncTaskCompletion), so this preserves the
    // "Done contributes 100" rule the spec requires.
    const rollup = (list: Array<{ completionPct: number; budgetHours: unknown }>) => {
      if (list.length === 0) return 0;
      const totalH = list.reduce((s, t) => s + Number(t.budgetHours || 0), 0);
      if (totalH > 0) {
        return Math.round(list.reduce((s, t) => s + t.completionPct * Number(t.budgetHours || 0), 0) / totalH);
      }
      return Math.round(list.reduce((s, t) => s + t.completionPct, 0) / list.length);
    };

    const weightedProgress = rollup(tasks);

    // Status breakdown
    const statusCounts: Record<string, number> = {};
    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // Per-zone progress. Project-root tasks (zoneId null, no zone) are
    // skipped — they aren't part of any zone's rollup.
    const zoneMap = new Map<number, { name: string; tasks: Array<{ completionPct: number; budgetHours: unknown }> }>();
    for (const t of tasks) {
      if (!t.zone || t.zoneId == null) continue;
      const zid = t.zoneId;
      if (!zoneMap.has(zid)) zoneMap.set(zid, { name: t.zone.name, tasks: [] });
      zoneMap.get(zid)!.tasks.push(t);
    }

    const zoneProgress = [...zoneMap.entries()].map(([id, z]) => ({
      zoneId: id,
      zoneName: z.name,
      taskCount: z.tasks.length,
      progress: rollup(z.tasks),
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
          body: `Task in project "${task.project?.name ?? '(personal)'}" was due ${task.endDate?.toLocaleDateString()}`,
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

  // ─── OPERATIONS DASHBOARD ──────────────────────────────────────────────
  //
  // Extended in feat/ops-complete (2026-08) to answer the BM requirements
  // doc: per-department project/deliverable/task counts + per-member
  // counts on the Team tab, an "employees at risk" panel on the Risk
  // tab, and a service-intensity summary. BIM Leader and Active Projects
  // tabs are separate endpoints (see getBimLeaderDashboard and
  // getActiveProjectsDashboard below) because they answer distinct
  // questions and would bloat this response.
  //
  // Everything below runs on the caller's accessible project set (via
  // ProjectAccessService.getAccessibleProjectIds — includes direct
  // membership + leadership + department backup + hierarchical subs)
  // and optionally narrows to the caller's department when
  // myDeptOnly=true.

  private resolveOpsScope(user: { id: number; roleId?: number | null }, myDeptOnlyRaw?: string) {
    const scopeToMyDept = String(myDeptOnlyRaw ?? '').toLowerCase() === 'true';
    return { scopeToMyDept, userId: user.id, roleId: user.roleId ?? null };
  }

  async getOperationsDashboard(user: { id: number; roleId?: number | null }, myDeptOnlyRaw?: string) {
    const { scopeToMyDept } = this.resolveOpsScope(user, myDeptOnlyRaw);
    const now = new Date();

    const acc = await this.access.getAccessibleProjectIds(user.id, user.roleId);
    const projectScope = acc.all ? {} : { id: { in: acc.projectIds } };

    const caller = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { department: true },
    });
    const callerDept = caller?.department ?? null;
    const applyDeptScope = scopeToMyDept && !!callerDept;

    const activeProjects = await this.prisma.project.findMany({
      where: { ...projectScope, deletedAt: null, status: { in: ['active', 'on_hold'] } },
      include: {
        leader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        department: { select: { id: true, name: true } },
        _count: { select: { tasks: true, zones: true, members: true } },
      },
    });

    const projectIds = activeProjects.map((p) => p.id);

    const allTasks = await this.prisma.task.findMany({
      where: { projectId: { in: projectIds }, deletedAt: null, isArchived: false, status: { notIn: ['completed', 'cancelled'] } },
      include: {
        project: { select: { id: true, name: true, number: true } },
        zone: { select: { id: true, name: true } },
        serviceType: { select: { id: true, name: true, code: true, color: true } },
        assignees: { where: { deletedAt: null }, include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, position: true, department: true } } } },
        dependencies: { include: { dependsOn: { select: { id: true, status: true } } } },
      },
    });

    const overdueTasks = allTasks.filter((t) => t.endDate && new Date(t.endDate) < now);
    const overdueIds = new Set(overdueTasks.map((t) => t.id));

    const blockedByOverdue = allTasks.filter((t) =>
      t.dependencies?.some((d) => overdueIds.has(d.dependsOnId) || (d.dependsOn?.status && d.dependsOn.status !== 'completed'))
    );

    // Budget aggregate per project — one aggregate per project so this
    // stays O(activeProjects), not O(activeProjects × tasks).
    const budgetData = await Promise.all(activeProjects.map(async (p) => {
      const [taskBudget, timeLogged] = await Promise.all([
        this.prisma.task.aggregate({ where: { projectId: p.id, deletedAt: null, isArchived: false }, _sum: { budgetAmount: true, budgetHours: true }, _count: true }),
        this.prisma.timeEntry.aggregate({
          where: { deletedAt: null, task: { projectId: p.id } },
          _sum: { minutes: true },
        }),
      ]);
      return { projectId: p.id, budgetAmount: Number(taskBudget._sum.budgetAmount ?? 0), budgetHours: Number(taskBudget._sum.budgetHours ?? 0), loggedMinutes: Number(timeLogged._sum.minutes ?? 0) };
    }));
    const budgetMap = new Map(budgetData.map((b) => [b.projectId, b]));

    const projectRisks = activeProjects.map((p) => {
      const bd = budgetMap.get(p.id);
      const projectOverdue = overdueTasks.filter((t) => t.projectId === p.id);
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
        overdueTasks: projectOverdue.map((t) => ({
          id: t.id, code: t.code, name: t.name,
          zone: t.zone?.name ?? 'Project Root',
          assignee: t.assignees?.[0]?.user ?? null,
          hoursLeft: Number(t.budgetHours ?? 0),
          daysOverdue: Math.round((now.getTime() - new Date(t.endDate!).getTime()) / 86400000),
          priority: t.priority,
          blockedTasks: blockedByOverdue.filter((b) => b.dependencies?.some((d) => d.dependsOnId === t.id)).length,
        })),
        blockedTasks: blockedByOverdue.filter((t) => t.projectId === p.id).length,
      };
    })
      .filter((p) => p.status !== 'ok' || p.overdueTasks.length > 0)
      .sort((a, b) => { const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, ok: 3 }; return (rank[a.status] ?? 3) - (rank[b.status] ?? 3); });

    // ── Team load by department ─────────────────────────────────────
    // Team + department counts. When "my dept only" is on, narrow the
    // employee set — managers see only their own people.
    const employees = await this.prisma.user.findMany({
      where: {
        isActive: true,
        userType: { in: ['employee', 'both'] },
        deletedAt: null,
        ...(applyDeptScope ? { department: callerDept ?? undefined } : {}),
      },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true, position: true, department: true, dailyStandardHours: true },
    });

    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 4); weekEnd.setHours(23, 59, 59, 999);

    const weekEntries = await this.prisma.timeEntry.groupBy({ by: ['userId'], where: { deletedAt: null, date: { gte: weekStart, lte: weekEnd } }, _sum: { minutes: true } });
    const hoursMap = new Map(weekEntries.map((e) => [e.userId, Math.round(Number(e._sum.minutes ?? 0) / 60)]));

    const taskCountByUser = await this.prisma.taskAssignee.groupBy({ by: ['userId'], where: { deletedAt: null, task: { deletedAt: null, status: { notIn: ['completed', 'cancelled'] } } }, _count: true });
    const taskCountMap = new Map(taskCountByUser.map((t) => [t.userId, t._count]));

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
          projectDeliverableId: (t as any).projectDeliverableId ?? null,
        });
      }
    }

    // Per-department + per-member counts (projects / deliverables /
    // open tasks). These extend the previous Team tab which showed
    // only hours vs capacity. Per BM feedback: "add # projects, #
    // deliverables, # open tasks per department AND per member".
    // Projects: unique project ids across the member's task list.
    // Deliverables: unique projectDeliverableId (fallback: unique
    // (projectId, zone) if the task has no deliverable link).
    // Open tasks: total tasks in taskList (already filtered to
    // status != completed/cancelled at query time).
    const deptMap = new Map<string, any>();
    for (const emp of employees) {
      const deptName = emp.department || 'Unassigned';
      if (!deptMap.has(deptName)) deptMap.set(deptName, { name: deptName, members: [], _projectIds: new Set<number>(), _deliverableIds: new Set<number>(), _openTasks: 0 });
      const dept = deptMap.get(deptName);
      const capacity = Number(emp.dailyStandardHours ?? 8) * 5;
      const empTasks = memberTasksMap.get(emp.id) ?? [];

      const memberProjectIds = new Set<number>();
      const memberDeliverableIds = new Set<number>();
      for (const t of empTasks) {
        if (t.projectId != null) memberProjectIds.add(t.projectId);
        if (t.projectDeliverableId != null) memberDeliverableIds.add(t.projectDeliverableId);
      }
      for (const id of memberProjectIds) dept._projectIds.add(id);
      for (const id of memberDeliverableIds) dept._deliverableIds.add(id);
      dept._openTasks += empTasks.length;

      dept.members.push({
        id: emp.id, firstName: emp.firstName, lastName: emp.lastName, avatarUrl: emp.avatarUrl, position: emp.position,
        hoursWeek: hoursMap.get(emp.id) ?? 0, capacity, tasks: taskCountMap.get(emp.id) ?? 0,
        overdueTasks: empTasks.filter((t) => t.daysOverdue !== null && t.daysOverdue > 0).length,
        openTasks: empTasks.length,
        projectCount: memberProjectIds.size,
        deliverableCount: memberDeliverableIds.size,
        taskList: empTasks,
      });
    }

    const departments = Array.from(deptMap.values()).map((d) => ({
      name: d.name,
      members: d.members,
      totalHours: d.members.reduce((s: number, m: any) => s + m.hoursWeek, 0),
      totalCapacity: d.members.reduce((s: number, m: any) => s + m.capacity, 0),
      totalOverdue: d.members.reduce((s: number, m: any) => s + m.overdueTasks, 0),
      projectCount: (d._projectIds as Set<number>).size,
      deliverableCount: (d._deliverableIds as Set<number>).size,
      openTaskCount: d._openTasks,
    }));

    const overloaded = employees.filter((e) => (hoursMap.get(e.id) ?? 0) > Number(e.dailyStandardHours ?? 8) * 5);
    const available = employees.filter((e) => (hoursMap.get(e.id) ?? 0) < Number(e.dailyStandardHours ?? 8) * 5 * 0.7);

    // ── Employees at risk (feat/ops-complete) ────────────────────────
    // Overloaded (this week hours > weekly capacity) AND carrying at
    // least one overdue task. Reuses the overloaded + memberTasks
    // signals above — no new data sources per the spec.
    const employeesAtRisk = employees
      .map((e) => {
        const tasks = memberTasksMap.get(e.id) ?? [];
        const overdueForUser = tasks.filter((t) => t.daysOverdue !== null && t.daysOverdue > 0);
        const cap = Number(e.dailyStandardHours ?? 8) * 5;
        const week = hoursMap.get(e.id) ?? 0;
        const isOverloaded = week > cap;
        return { emp: e, overdueForUser, cap, week, isOverloaded };
      })
      .filter((r) => r.isOverloaded && r.overdueForUser.length > 0)
      .map((r) => ({
        id: r.emp.id,
        firstName: r.emp.firstName,
        lastName: r.emp.lastName,
        avatarUrl: r.emp.avatarUrl,
        position: r.emp.position,
        department: r.emp.department,
        hoursWeek: r.week,
        capacity: r.cap,
        overloadPct: r.cap > 0 ? Math.round(r.week / r.cap * 100) : 0,
        overdueCount: r.overdueForUser.length,
        overdueTasks: r.overdueForUser.slice(0, 5).map((t) => ({
          id: t.id, code: t.code, name: t.name,
          projectId: t.projectId, projectName: t.projectName,
          daysOverdue: t.daysOverdue,
        })),
      }))
      .sort((a, b) => b.overloadPct - a.overloadPct || b.overdueCount - a.overdueCount);

    // ── Service intensity (feat/ops-complete) ───────────────────────
    // Generalises the BIM/MEP load view to every ServiceType across
    // in-scope active projects. Open-task count + overdue count per
    // service, sorted by openTasks desc so the hottest services
    // surface first.
    const serviceMap = new Map<number, { id: number; name: string; code: string | null; color: string | null; openTasks: number; overdueTasks: number; projectIds: Set<number>; hoursLeft: number }>();
    for (const t of allTasks) {
      const svc = (t as any).serviceType;
      if (!svc) continue;
      if (!serviceMap.has(svc.id)) {
        serviceMap.set(svc.id, { id: svc.id, name: svc.name, code: svc.code ?? null, color: svc.color ?? null, openTasks: 0, overdueTasks: 0, projectIds: new Set(), hoursLeft: 0 });
      }
      const row = serviceMap.get(svc.id)!;
      row.openTasks += 1;
      if (t.projectId != null) row.projectIds.add(t.projectId);
      row.hoursLeft += Number(t.budgetHours ?? 0);
      if (t.endDate && new Date(t.endDate) < now) row.overdueTasks += 1;
    }
    const services = [...serviceMap.values()].map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      color: s.color,
      openTasks: s.openTasks,
      overdueTasks: s.overdueTasks,
      projectCount: s.projectIds.size,
      hoursLeft: Math.round(s.hoursLeft),
    })).sort((a, b) => b.openTasks - a.openTasks);

    // ── Review queue ─────────────────────────────────────────────────
    const submitterFilter = applyDeptScope
      ? { creator: { department: callerDept ?? undefined } }
      : {};
    const reviewTasks = await this.prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        isArchived: false,
        status: 'in_review',
        ...submitterFilter,
      },
      include: {
        project: { select: { id: true, name: true, number: true } },
        zone: { select: { id: true, name: true } },
        creator: { select: { id: true, firstName: true, lastName: true, avatarUrl: true, department: true } },
        assignees: { where: { deletedAt: null }, include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } } },
        reviewEvents: { orderBy: { createdAt: 'desc' }, take: 1, select: { action: true, actorId: true, createdAt: true, reason: true } },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 100,
    });
    const reviewQueue = reviewTasks.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      priority: t.priority,
      projectId: t.projectId,
      projectName: t.project?.name,
      zone: t.zone?.name ?? 'Project Root',
      submitter: t.creator ? { id: t.creator.id, firstName: t.creator.firstName, lastName: t.creator.lastName, department: t.creator.department } : null,
      assignee: t.assignees?.[0]?.user ?? null,
      submittedAt: t.reviewEvents?.[0]?.createdAt ?? t.updatedAt,
      lastAction: t.reviewEvents?.[0]?.action ?? 'submit',
      returnCount: 0,
    }));
    if (reviewQueue.length > 0) {
      const returns = await this.prisma.taskReviewEvent.groupBy({
        by: ['taskId'],
        where: { taskId: { in: reviewQueue.map((r) => r.id) }, action: 'return' },
        _count: true,
      });
      const returnMap = new Map(returns.map((r) => [r.taskId, r._count]));
      for (const r of reviewQueue) r.returnCount = Number(returnMap.get(r.id) ?? 0);
    }

    return {
      summary: {
        totalOverdue: overdueTasks.length,
        totalBlocked: blockedByOverdue.length,
        overloadedCount: overloaded.length,
        availableCount: available.length,
        availableHours: available.reduce((s, e) => s + (Number(e.dailyStandardHours ?? 8) * 5 - (hoursMap.get(e.id) ?? 0)), 0),
        reviewCount: reviewQueue.length,
        employeesAtRiskCount: employeesAtRisk.length,
      },
      projects: projectRisks,
      departments,
      reviewQueue,
      employeesAtRisk,
      services,
      scope: {
        myDeptOnly: applyDeptScope,
        deptName: applyDeptScope ? callerDept : null,
      },
    };
  }

  // ─── BIM LEADER DASHBOARD (feat/ops-complete) ──────────────────────────
  //
  // Groups the caller's accessible projects by BIM Leader. BIM Leader is
  // resolved via ProjectPartnerRole with role code `bim_leader`
  // (matches tasks.service and projects.service). Per-leader counts:
  //   # active projects, # deliverables (distinct ProjectDeliverable ids),
  //   # open tasks (status not in completed/cancelled), # overdue.
  // Expandable to the individual projects beneath each leader.
  //
  // myDeptOnly narrows to projects with departmentId matching the
  // caller's Department. Same shape as the ops dashboard's dept filter.
  async getBimLeaderDashboard(user: { id: number; roleId?: number | null }, myDeptOnlyRaw?: string) {
    const { scopeToMyDept } = this.resolveOpsScope(user, myDeptOnlyRaw);
    const now = new Date();

    const acc = await this.access.getAccessibleProjectIds(user.id, user.roleId);
    const projectScope = acc.all ? {} : { id: { in: acc.projectIds } };

    // Dept filter — resolve caller's department string → Department.id
    // → narrow project scope to projects with that departmentId.
    const caller = await this.prisma.user.findUnique({ where: { id: user.id }, select: { department: true } });
    const callerDept = caller?.department ?? null;
    let deptId: number | null = null;
    if (scopeToMyDept && callerDept) {
      const d = await this.prisma.department.findUnique({ where: { name: callerDept }, select: { id: true } });
      deptId = d?.id ?? null;
    }
    const applyDeptScope = scopeToMyDept && deptId != null;

    const projects = await this.prisma.project.findMany({
      where: {
        ...projectScope,
        deletedAt: null,
        status: { in: ['active', 'on_hold'] },
        ...(applyDeptScope ? { departmentId: deptId! } : {}),
      },
      select: {
        id: true, name: true, number: true, status: true, endDate: true,
        department: { select: { id: true, name: true } },
      },
    });

    if (projects.length === 0) {
      return { leaders: [], scope: { myDeptOnly: applyDeptScope, deptName: applyDeptScope ? callerDept : null } };
    }

    const projectIds = projects.map((p) => p.id);

    // Resolve bim_leader for these projects in one pass (mirrors the
    // batching in tasks.service.ts).
    const bimRoleType = await this.prisma.projectRoleType.findUnique({ where: { code: 'bim_leader' } });
    const leaderByProject = new Map<number, { key: string; label: string; userId: number | null } | null>();

    if (bimRoleType) {
      const pprs = await this.prisma.projectPartnerRole.findMany({
        where: {
          projectId: { in: projectIds },
          roleId: bimRoleType.id,
          OR: [{ validTo: { gte: now } as any }, { validTo: undefined as any }],
        },
        include: { party: { select: { id: true, displayName: true, firstName: true, lastName: true } } },
      });
      const bpIds = pprs.map((p) => p.party?.id).filter((v): v is number => v != null);
      const usersByBp = bpIds.length
        ? await this.prisma.user.findMany({
            where: { businessPartnerId: { in: bpIds }, isActive: true },
            select: { id: true, businessPartnerId: true, firstName: true, lastName: true },
          })
        : [];
      const userByBp = new Map(usersByBp.map((u) => [u.businessPartnerId!, u]));

      for (const ppr of pprs) {
        const bp = ppr.party;
        if (!bp) continue;
        const linked = userByBp.get(bp.id);
        if (linked) {
          leaderByProject.set(ppr.projectId, {
            key: `u:${linked.id}`,
            label: `${linked.firstName ?? ''} ${linked.lastName ?? ''}`.trim() || bp.displayName || 'BIM Leader',
            userId: linked.id,
          });
        } else {
          const hasFull = !!(bp.firstName && bp.lastName);
          const label = hasFull ? `${bp.firstName} ${bp.lastName}` : (bp.displayName ?? bp.firstName ?? 'BIM Leader');
          leaderByProject.set(ppr.projectId, { key: `bp:${bp.id}`, label, userId: null });
        }
      }
    }

    // Per-project aggregates in one shot.
    const openTaskGroup = await this.prisma.task.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['completed', 'cancelled'] },
      },
      _count: true,
    });
    const openTasksByProject = new Map(openTaskGroup.map((r) => [r.projectId!, r._count]));

    const overdueGroup = await this.prisma.task.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['completed', 'cancelled'] },
        endDate: { lt: now },
      },
      _count: true,
    });
    const overdueByProject = new Map(overdueGroup.map((r) => [r.projectId!, r._count]));

    const deliverableGroup = await this.prisma.projectDeliverable.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, deletedAt: null },
      _count: true,
    });
    const deliverablesByProject = new Map(deliverableGroup.map((r) => [r.projectId, r._count]));

    // Group projects by BIM leader key. Projects without a leader roll
    // up under a synthetic "No BIM Leader" bucket so the operator still
    // sees where the coverage gap is.
    const leaders = new Map<string, {
      key: string; label: string; userId: number | null;
      projectCount: number; deliverableCount: number; openTaskCount: number; overdueCount: number;
      projects: Array<{
        id: number; name: string; number: string | null;
        status: string; department: { id: number; name: string } | null;
        openTasks: number; overdueTasks: number; deliverables: number;
      }>;
    }>();

    for (const p of projects) {
      const info = leaderByProject.get(p.id) ?? { key: 'none', label: 'No BIM Leader', userId: null };
      if (!leaders.has(info.key)) {
        leaders.set(info.key, {
          key: info.key, label: info.label, userId: info.userId,
          projectCount: 0, deliverableCount: 0, openTaskCount: 0, overdueCount: 0,
          projects: [],
        });
      }
      const bucket = leaders.get(info.key)!;
      const openTasks = openTasksByProject.get(p.id) ?? 0;
      const overdueTasks = overdueByProject.get(p.id) ?? 0;
      const deliverables = deliverablesByProject.get(p.id) ?? 0;
      bucket.projectCount += 1;
      bucket.openTaskCount += openTasks;
      bucket.overdueCount += overdueTasks;
      bucket.deliverableCount += deliverables;
      bucket.projects.push({
        id: p.id, name: p.name, number: p.number ?? null,
        status: p.status,
        department: p.department ? { id: p.department.id, name: p.department.name } : null,
        openTasks, overdueTasks, deliverables,
      });
    }

    // Sort: most projects first, then most overdue.
    const rows = [...leaders.values()].sort((a, b) => b.projectCount - a.projectCount || b.overdueCount - a.overdueCount);
    for (const r of rows) r.projects.sort((a, b) => b.overdueTasks - a.overdueTasks || a.name.localeCompare(b.name));

    return {
      leaders: rows,
      scope: {
        myDeptOnly: applyDeptScope,
        deptName: applyDeptScope ? callerDept : null,
      },
    };
  }

  // ─── ACTIVE PROJECTS DASHBOARD (feat/ops-complete) ─────────────────────
  //
  // "Active" per BM requirements = a project that has EITHER an open
  // task due within the next 30 days OR any timeEntry / ActivityLog in
  // the last 14 days. Everything else is DORMANT (still listed —
  // operators want to see the coverage gap). Per project:
  //   • lastActivityDate — MAX(timeEntry.date OR activityLog.createdAt)
  //   • upcomingDueCount — open tasks with endDate ≤ now + 30d
  //   • loggedHours14d — sum of time-entry hours in the last 14 days
  //   • flag — ACTIVE / DORMANT
  //
  // myDeptOnly narrows scope to projects with a matching department.
  async getActiveProjectsDashboard(user: { id: number; roleId?: number | null }, myDeptOnlyRaw?: string) {
    const { scopeToMyDept } = this.resolveOpsScope(user, myDeptOnlyRaw);
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const back14 = new Date(now.getTime() - 14 * 86400000);

    const acc = await this.access.getAccessibleProjectIds(user.id, user.roleId);
    const projectScope = acc.all ? {} : { id: { in: acc.projectIds } };

    const caller = await this.prisma.user.findUnique({ where: { id: user.id }, select: { department: true } });
    const callerDept = caller?.department ?? null;
    let deptId: number | null = null;
    if (scopeToMyDept && callerDept) {
      const d = await this.prisma.department.findUnique({ where: { name: callerDept }, select: { id: true } });
      deptId = d?.id ?? null;
    }
    const applyDeptScope = scopeToMyDept && deptId != null;

    const projects = await this.prisma.project.findMany({
      where: {
        ...projectScope,
        deletedAt: null,
        status: { in: ['active', 'on_hold'] },
        ...(applyDeptScope ? { departmentId: deptId! } : {}),
      },
      select: {
        id: true, name: true, number: true, status: true, endDate: true,
        leader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        department: { select: { id: true, name: true } },
      },
    });

    if (projects.length === 0) {
      return {
        projects: [],
        totalCount: 0,
        activeCount: 0,
        dormantCount: 0,
        scope: { myDeptOnly: applyDeptScope, deptName: applyDeptScope ? callerDept : null },
      };
    }

    const projectIds = projects.map((p) => p.id);

    // Batched aggregates — one round-trip each (mirrors the getOpsDashboard
    // aggregate pattern), so this stays O(1) queries regardless of the
    // project count.
    const [upcomingByProject, entriesByProject, lastEntryByProject, lastLogByProject] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['projectId'],
        where: {
          projectId: { in: projectIds },
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['completed', 'cancelled'] },
          endDate: { gte: now, lte: in30 },
        },
        _count: true,
      }),
      this.prisma.timeEntry.groupBy({
        by: ['taskId'],
        // Route time entries via task.projectId; project_id on time_entries
        // is NULL on many historical rows and would understate activity.
        where: {
          deletedAt: null,
          date: { gte: back14 },
          task: { projectId: { in: projectIds } },
        },
        _sum: { minutes: true },
      }),
      // Latest time-entry per project — used as one signal of last
      // activity date. Same task.projectId join for consistency.
      this.prisma.timeEntry.findMany({
        where: {
          deletedAt: null,
          task: { projectId: { in: projectIds } },
        },
        orderBy: { date: 'desc' },
        select: { date: true, task: { select: { projectId: true } } },
        take: 5000, // guardrail — 5000 rows is enough to have the newest
                    // per project without blowing the response.
      }),
      // Latest activity log per project — activityLog is projectId-tagged
      // directly. Cheap indexed query on (project_id, created_at).
      this.prisma.activityLog.findMany({
        where: { projectId: { in: projectIds } },
        orderBy: { createdAt: 'desc' },
        select: { projectId: true, createdAt: true },
        take: 5000,
      }),
    ]);

    // Roll time-entry hours per project (via the task→project join).
    const taskProjectMap = new Map<number, number>();
    // Fetch a tiny task→project map covering exactly the tasks that
    // appeared in the entriesByProject aggregate.
    const taskIdsForEntries = entriesByProject.map((r) => r.taskId).filter((v): v is number => v != null);
    if (taskIdsForEntries.length > 0) {
      const rows = await this.prisma.task.findMany({
        where: { id: { in: taskIdsForEntries } },
        select: { id: true, projectId: true },
      });
      for (const r of rows) if (r.projectId != null) taskProjectMap.set(r.id, r.projectId);
    }
    const loggedMinutesByProject = new Map<number, number>();
    for (const row of entriesByProject) {
      if (row.taskId == null) continue;
      const pid = taskProjectMap.get(row.taskId);
      if (pid == null) continue;
      loggedMinutesByProject.set(pid, (loggedMinutesByProject.get(pid) ?? 0) + Number(row._sum.minutes ?? 0));
    }

    const upcomingMap = new Map(upcomingByProject.map((r) => [r.projectId!, r._count]));

    // Newest time-entry date per project.
    const lastEntryByPid = new Map<number, Date>();
    for (const e of lastEntryByProject) {
      const pid = e.task?.projectId;
      if (pid == null) continue;
      const cur = lastEntryByPid.get(pid);
      if (!cur || e.date > cur) lastEntryByPid.set(pid, e.date);
    }
    const lastLogByPid = new Map<number, Date>();
    for (const l of lastLogByProject) {
      if (l.projectId == null) continue;
      const cur = lastLogByPid.get(l.projectId);
      if (!cur || l.createdAt > cur) lastLogByPid.set(l.projectId, l.createdAt);
    }

    const rows = projects.map((p) => {
      const upcoming = upcomingMap.get(p.id) ?? 0;
      const loggedHours = Math.round((loggedMinutesByProject.get(p.id) ?? 0) / 60);
      const lastE = lastEntryByPid.get(p.id) ?? null;
      const lastA = lastLogByPid.get(p.id) ?? null;
      const lastActivityDate = lastE && lastA ? (lastE > lastA ? lastE : lastA) : (lastE ?? lastA);
      const active = upcoming > 0 || loggedHours > 0 || (lastActivityDate != null && lastActivityDate >= back14);
      return {
        id: p.id, name: p.name, number: p.number, status: p.status,
        endDate: p.endDate,
        leader: p.leader, department: p.department,
        lastActivityDate,
        upcomingDueCount: upcoming,
        loggedHours14d: loggedHours,
        flag: (active ? 'active' : 'dormant') as 'active' | 'dormant',
      };
    });

    // Sort: ACTIVE first, then most-recent activity first.
    rows.sort((a, b) => {
      if (a.flag !== b.flag) return a.flag === 'active' ? -1 : 1;
      const ta = a.lastActivityDate ? a.lastActivityDate.getTime() : 0;
      const tb = b.lastActivityDate ? b.lastActivityDate.getTime() : 0;
      return tb - ta;
    });

    return {
      projects: rows,
      totalCount: rows.length,
      activeCount: rows.filter((r) => r.flag === 'active').length,
      dormantCount: rows.filter((r) => r.flag === 'dormant').length,
      scope: {
        myDeptOnly: applyDeptScope,
        deptName: applyDeptScope ? callerDept : null,
      },
    };
  }

  // ─── EXECUTIVE REVIEW (feat/ops-complete) ──────────────────────────────
  //
  // Full task list feeding the Executive Review tab. Same access scope
  // as everything else in Operations. Returns each task's ops note (a
  // singular per-task annotation from TaskOpsNote) so the UI can render
  // the Comment column. Also returns any values the front-end needs
  // for its group-by / filter / sort / CSV — status, priority, phase,
  // department, service, assignee, dates, hours.
  //
  // Pagination is applied server-side: capped at `take` rows (default
  // 200), the total available count is returned so the UI can show a
  // "showing first N of M" affordance rather than silently truncating.
  async getExecutiveReview(user: { id: number; roleId?: number | null }, myDeptOnlyRaw?: string, takeRaw?: string) {
    const { scopeToMyDept } = this.resolveOpsScope(user, myDeptOnlyRaw);
    const take = Math.min(500, Math.max(50, Number(takeRaw ?? 200) || 200));

    const acc = await this.access.getAccessibleProjectIds(user.id, user.roleId);
    const projectScope = acc.all ? {} : { id: { in: acc.projectIds } };

    const caller = await this.prisma.user.findUnique({ where: { id: user.id }, select: { department: true } });
    const callerDept = caller?.department ?? null;
    let deptId: number | null = null;
    if (scopeToMyDept && callerDept) {
      const d = await this.prisma.department.findUnique({ where: { name: callerDept }, select: { id: true } });
      deptId = d?.id ?? null;
    }
    const applyDeptScope = scopeToMyDept && deptId != null;

    const projects = await this.prisma.project.findMany({
      where: {
        ...projectScope,
        deletedAt: null,
        status: { in: ['active', 'on_hold'] },
        ...(applyDeptScope ? { departmentId: deptId! } : {}),
      },
      select: { id: true },
    });
    const projectIds = projects.map((p) => p.id);

    if (projectIds.length === 0) {
      return {
        tasks: [],
        totalCount: 0,
        take,
        scope: { myDeptOnly: applyDeptScope, deptName: applyDeptScope ? callerDept : null },
      };
    }

    const [tasks, totalCount] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['completed', 'cancelled'] },
        },
        orderBy: [{ priority: 'asc' }, { endDate: 'asc' }, { updatedAt: 'desc' }],
        take,
        select: {
          id: true, code: true, name: true, status: true, priority: true,
          budgetHours: true, endDate: true, startDate: true, updatedAt: true,
          zone: { select: { id: true, name: true } },
          project: { select: { id: true, name: true, number: true, department: { select: { id: true, name: true } } } },
          phase: { select: { id: true, name: true } },
          serviceType: { select: { id: true, name: true, code: true, color: true } },
          assignees: {
            where: { deletedAt: null },
            include: { user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
          },
          opsNote: {
            select: {
              id: true, content: true, updatedAt: true,
              updatedByUser: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.task.count({
        where: {
          projectId: { in: projectIds },
          deletedAt: null,
          isArchived: false,
          status: { notIn: ['completed', 'cancelled'] },
        },
      }),
    ]);

    const now = new Date();
    const shaped = tasks.map((t) => ({
      id: t.id, code: t.code, name: t.name,
      status: t.status, priority: t.priority,
      hours: Number(t.budgetHours ?? 0),
      startDate: t.startDate, endDate: t.endDate,
      daysOverdue: t.endDate && new Date(t.endDate) < now
        ? Math.round((now.getTime() - new Date(t.endDate).getTime()) / 86400000)
        : null,
      zone: t.zone ? { id: t.zone.id, name: t.zone.name } : null,
      project: t.project ? {
        id: t.project.id, name: t.project.name, number: t.project.number,
        department: t.project.department ? { id: t.project.department.id, name: t.project.department.name } : null,
      } : null,
      phase: t.phase ? { id: t.phase.id, name: t.phase.name } : null,
      service: t.serviceType ? { id: t.serviceType.id, name: t.serviceType.name, code: t.serviceType.code ?? null, color: t.serviceType.color ?? null } : null,
      assignees: t.assignees.map((a) => ({
        id: a.user.id, firstName: a.user.firstName, lastName: a.user.lastName, avatarUrl: a.user.avatarUrl,
      })),
      opsNote: t.opsNote ? {
        content: t.opsNote.content,
        updatedAt: t.opsNote.updatedAt,
        updatedBy: t.opsNote.updatedByUser
          ? { id: t.opsNote.updatedByUser.id, firstName: t.opsNote.updatedByUser.firstName, lastName: t.opsNote.updatedByUser.lastName }
          : null,
      } : null,
    }));

    return {
      tasks: shaped,
      totalCount,
      take,
      scope: { myDeptOnly: applyDeptScope, deptName: applyDeptScope ? callerDept : null },
    };
  }

  // ─── OPS NOTE PERSISTENCE ──────────────────────────────────────────────
  //
  // Single per-task annotation editable from the Executive Review tab.
  // Uses upsert so the client doesn't have to know whether a row
  // exists yet — POST { content } → row created or updated in place.
  // Empty content deletes the row.

  async upsertTaskOpsNote(user: { id: number; roleId?: number | null }, taskId: number, content: string) {
    // Access check — reuse ProjectAccessService for task/project scope.
    await this.access.assertTaskAccess(user.id, taskId, user.roleId);
    const trimmed = (content ?? '').trim();
    if (!trimmed) {
      // Empty = clear the note.
      await this.prisma.taskOpsNote.deleteMany({ where: { taskId } });
      return { taskId, content: null };
    }
    if (trimmed.length > 4000) {
      throw new BadRequestException('Ops note may not exceed 4000 characters');
    }
    const row = await this.prisma.taskOpsNote.upsert({
      where: { taskId },
      create: { taskId, content: trimmed, updatedBy: user.id },
      update: { content: trimmed, updatedBy: user.id },
      select: {
        content: true, updatedAt: true,
        updatedByUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return {
      taskId,
      content: row.content,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedByUser
        ? { id: row.updatedByUser.id, firstName: row.updatedByUser.firstName, lastName: row.updatedByUser.lastName }
        : null,
    };
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
