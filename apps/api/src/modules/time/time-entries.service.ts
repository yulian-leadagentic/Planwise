import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { startOfDay, endOfDay, addDays, parseISO, format } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { minutesOverlap } from '../../common/overlap';
import { taskCompletionValue } from '../../common/task-completion';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import * as Sentry from '@sentry/node';

/** Minutes since midnight from an HH:MM string (rejects undefined). */
function hhmmToMinutes(s?: string | null): number | null {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Same-day overlap check shared by create() and update(). Throws 409
 * with a structured payload the client renders as a conflict card. Per
 * the 2026-06-14 NO-overlap policy, both same-task and cross-task
 * overlaps are hard rejects — no override flag.
 *
 * `excludeId` lets the update() path skip the entry being edited.
 */
async function assertNoTimeOverlap(
  prisma: PrismaService,
  args: {
    userId: number;
    date: Date;
    startTime: string | null | undefined;
    endTime: string | null | undefined;
    dateStr: string;
    taskId?: number | null;
    excludeId?: number;
  },
): Promise<void> {
  const newStart = hhmmToMinutes(args.startTime);
  const newEnd = hhmmToMinutes(args.endTime);
  // Legacy hours-only entries (no clock window) can't conflict.
  if (newStart == null || newEnd == null || newEnd <= newStart) return;

  const sameDayEntries = await prisma.timeEntry.findMany({
    where: {
      userId: args.userId,
      deletedAt: null,
      date: { gte: startOfDay(args.date), lte: endOfDay(args.date) },
      NOT: [{ startTime: null }, { endTime: null }],
      ...(args.excludeId != null ? { id: { not: args.excludeId } } : {}),
    },
    select: {
      id: true,
      taskId: true,
      startTime: true,
      endTime: true,
      task: { select: { id: true, name: true, code: true } },
    },
  });

  const sameTaskConflicts: Array<{ id: number; startTime: string; endTime: string }> = [];
  const crossTaskConflicts: Array<{
    id: number;
    taskId: number | null;
    taskName: string | null;
    taskCode: string | null;
    startTime: string;
    endTime: string;
  }> = [];

  for (const e of sameDayEntries) {
    const s = hhmmToMinutes(e.startTime);
    const en = hhmmToMinutes(e.endTime);
    if (s == null || en == null) continue;
    if (!minutesOverlap(newStart, newEnd, s, en)) continue;
    if (e.taskId === args.taskId) {
      sameTaskConflicts.push({
        id: e.id,
        startTime: e.startTime!,
        endTime: e.endTime!,
      });
    } else {
      crossTaskConflicts.push({
        id: e.id,
        taskId: e.taskId,
        taskName: e.task?.name ?? null,
        taskCode: e.task?.code ?? null,
        startTime: e.startTime!,
        endTime: e.endTime!,
      });
    }
  }

  if (sameTaskConflicts.length > 0) {
    throw new ConflictException({
      code: 'SAME_TASK_OVERLAP',
      message: 'Time overlap on the same task is not allowed.',
      details: {
        date: args.dateStr,
        attempted: { startTime: args.startTime, endTime: args.endTime },
        conflicts: sameTaskConflicts,
      },
    });
  }

  if (crossTaskConflicts.length > 0) {
    throw new ConflictException({
      code: 'CROSS_TASK_OVERLAP',
      message: 'This entry overlaps with time logged on another task.',
      details: {
        date: args.dateStr,
        attempted: { startTime: args.startTime, endTime: args.endTime },
        conflicts: crossTaskConflicts,
      },
    });
  }
}

@Injectable()
export class TimeEntriesService {
  constructor(
    private prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async create(userId: number, dto: CreateTimeEntryDto) {
    // Parse date as local midnight (not UTC) to avoid timezone issues
    const dateParts = dto.date.split('-').map(Number);
    const localDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);

    // Auto-derive projectId from the task when the caller didn't pass it
    // (QuickTimeLog / TaskDrawer call sites historically did this
    // inconsistently — leaving a column that aggregations rely on
    // half-empty). Belt-and-suspenders: aggregations now also resolve
    // project membership via task.projectId, but keeping this column
    // populated keeps the data clean for any future direct queries.
    let projectId = dto.projectId;
    if (!projectId && dto.taskId) {
      const t = await this.prisma.task.findUnique({
        where: { id: dto.taskId },
        select: { projectId: true },
      });
      if (t?.projectId != null) projectId = t.projectId;
    }

    // Overlap validation — both same-task and cross-task overlaps are
    // hard rejects per the 2026-06-14 no-overlap policy. The shared helper
    // is also called by update() so both code paths stay aligned.
    await assertNoTimeOverlap(this.prisma, {
      userId,
      date: localDate,
      startTime: dto.startTime,
      endTime: dto.endTime,
      dateStr: dto.date,
      taskId: dto.taskId ?? null,
    });

    const entry = await this.prisma.timeEntry.create({
      data: {
        userId,
        timeClockId: dto.timeClockId,
        projectId,
        taskId: dto.taskId,
        date: localDate,
        startTime: dto.startTime ?? null,
        endTime: dto.endTime ?? null,
        minutes: dto.minutes,
        note: dto.note,
        isBillable: dto.isBillable ?? true,
        location: dto.location ?? null,
        completionPct: dto.completionPct ?? null,
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
    });

    // Update task completionPct based on logged hours vs budget
    if (dto.taskId) {
      await this.syncTaskCompletion(dto.taskId);
    }

    // Audit trail — time entries roll up to the project via projectId (or
    // via the task's projectId when the caller didn't pass one). Kept
    // defensive so a log failure never breaks the write.
    try {
      const hours = entry.minutes / 60;
      await this.activityLog.write({
        category: 'time',
        action: 'time.entry.created',
        actorUserId: userId,
        projectId: entry.projectId ?? null,
        entityType: 'time_entry',
        entityId: entry.id,
        entityName: entry.task?.name ?? null,
        description: `Logged ${hours.toFixed(2)}h` +
          (entry.task?.name ? ` on "${entry.task.name}"` : ''),
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return entry;
  }

  private async syncTaskCompletion(taskId: number) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { budgetHours: true, status: true },
    });
    if (!task) return;

    // Completion-rate model: delegated to the canonical helper at
    // `apps/api/src/common/task-completion` so this write path can't
    // drift from the read-time rollups in `execution-planning.service`,
    // `projects.service#findAll`, or the web helpers
    // (`apps/web/src/lib/completion-rollup.ts`,
    // `apps/web/src/lib/task-health.ts`). Formula recap:
    //   • completed / cancelled → 100
    //   • in_review             → 90
    //   • everything else       → min(80, round(loggedHours / budget × 80))
    //
    // The workflow-driven statuses never touch the DB for a logged-time
    // sum. For the remaining time-based branch we still short-circuit
    // when there's no budget to divide by, so the code path stays
    // db-cheap.
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'in_review') {
      await this.prisma.task.update({
        where: { id: taskId },
        data: { completionPct: taskCompletionValue({ status: task.status, budgetHours: task.budgetHours }) },
      });
      return;
    }

    if (!task.budgetHours || Number(task.budgetHours) === 0) return;

    const agg = await this.prisma.timeEntry.aggregate({
      where: { taskId, deletedAt: null },
      _sum: { minutes: true },
    });
    const pct = taskCompletionValue({
      status: task.status,
      budgetHours: task.budgetHours,
      loggedMinutes: agg._sum.minutes ?? 0,
    });

    await this.prisma.task.update({
      where: { id: taskId },
      data: { completionPct: pct },
    });
  }

  async batchCreate(userId: number, entries: CreateTimeEntryDto[]) {
    // Pre-resolve task -> projectId for any entry that has a taskId but
    // no explicit projectId, so the batch creates have project_id
    // populated. Same belt-and-suspenders rationale as create().
    const taskIdsNeedingLookup = Array.from(new Set(
      entries
        .filter((e) => e.taskId && !e.projectId)
        .map((e) => e.taskId as number),
    ));
    const taskProjectMap = new Map<number, number>();
    if (taskIdsNeedingLookup.length > 0) {
      const tasks = await this.prisma.task.findMany({
        where: { id: { in: taskIdsNeedingLookup } },
        select: { id: true, projectId: true },
      });
      // Task.projectId is now nullable (personal tasks). Only cache the
       // resolved mapping when the task IS tied to a project.
      for (const t of tasks) {
        if (t.projectId != null) taskProjectMap.set(t.id, t.projectId);
      }
    }

    const data = entries.map((dto) => {
      const dp = dto.date.split('-').map(Number);
      const resolvedProjectId =
        dto.projectId ?? (dto.taskId ? taskProjectMap.get(dto.taskId) ?? null : null);
      return {
        userId,
        timeClockId: dto.timeClockId ?? null,
        projectId: resolvedProjectId,
        taskId: dto.taskId ?? null,
        date: new Date(dp[0], dp[1] - 1, dp[2]),
        minutes: dto.minutes,
        note: dto.note ?? null,
        isBillable: dto.isBillable ?? true,
      };
    });

    await this.prisma.timeEntry.createMany({ data });

    // Return the created entries
    return this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { in: data.map((d) => d.date) },
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: data.length,
    });
  }

  /**
   * Return the calling user's time entries, optionally narrowed by task,
   * project, or a specific date. Scoped to `userId` so a user can never
   * peek at another person's reporting via query-param injection.
   *
   * The unfiltered case is bounded (take: 200) — this is the same endpoint
   * the kanban card hits to render a small history list, and we don't want
   * it pulling the whole table for a power-user with thousands of entries.
   */
  async listForUser(
    userId: number,
    filters: { taskId?: number; projectId?: number; date?: string },
  ) {
    const where: any = { userId, deletedAt: null };
    if (filters.taskId) where.taskId = filters.taskId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.date) {
      const dp = filters.date.split('-').map(Number);
      const dayStart = startOfDay(new Date(dp[0], dp[1] - 1, dp[2]));
      const dayEnd = endOfDay(new Date(dp[0], dp[1] - 1, dp[2]));
      where.date = { gte: dayStart, lte: dayEnd };
    }
    return this.prisma.timeEntry.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async findOne(id: number) {
    const entry = await this.prisma.timeEntry.findFirst({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
    });

    if (!entry) {
      throw new NotFoundException('Time entry not found');
    }

    return entry;
  }

  async update(id: number, dto: Partial<CreateTimeEntryDto>, userId?: number) {
    const existing = await this.findOne(id);

    // Re-run the overlap check on the patched view (caller may have
    // updated only some fields — merge with what's in the DB before
    // checking). Excluding `id` so the entry doesn't overlap with itself.
    const mergedDateStr = dto.date ?? format(existing.date, 'yyyy-MM-dd');
    const mergedDateParts = mergedDateStr.split('-').map(Number);
    const mergedDate = new Date(mergedDateParts[0], mergedDateParts[1] - 1, mergedDateParts[2]);
    const mergedStart = dto.startTime ?? existing.startTime;
    const mergedEnd = dto.endTime ?? existing.endTime;
    const mergedTaskId = dto.taskId ?? existing.taskId;

    await assertNoTimeOverlap(this.prisma, {
      userId: existing.userId,
      date: mergedDate,
      startTime: mergedStart,
      endTime: mergedEnd,
      dateStr: mergedDateStr,
      taskId: mergedTaskId,
      excludeId: id,
    });

    const updated = await this.prisma.timeEntry.update({
      where: { id },
      data: {
        ...dto,
        date: dto.date ? mergedDate : undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
    });

    try {
      const changedFields = Object.keys(dto);
      await this.activityLog.write({
        category: 'time',
        action: 'time.entry.updated',
        actorUserId: userId ?? existing.userId,
        projectId: updated.projectId ?? existing.projectId ?? null,
        entityType: 'time_entry',
        entityId: updated.id,
        entityName: updated.task?.name ?? existing.task?.name ?? null,
        description: `Updated time entry` +
          (updated.task?.name ? ` on "${updated.task.name}"` : '') +
          (changedFields.length ? ` — ${changedFields.join(', ')}` : ''),
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return updated;
  }

  async remove(id: number, userId?: number) {
    const existing = await this.findOne(id);
    await this.prisma.timeEntry.delete({ where: { id } });

    try {
      const hours = existing.minutes / 60;
      await this.activityLog.write({
        category: 'time',
        action: 'time.entry.deleted',
        actorUserId: userId ?? existing.userId,
        projectId: existing.projectId ?? null,
        entityType: 'time_entry',
        entityId: id,
        entityName: existing.task?.name ?? null,
        description: `Deleted ${hours.toFixed(2)}h time entry` +
          (existing.task?.name ? ` from "${existing.task.name}"` : ''),
        severity: 'warn',
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return { message: 'Time entry deleted' };
  }

  async getDailyBreakdown(userId: number, dateStr: string) {
    const date = parseISO(dateStr);
    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: dayStart, lte: dayEnd },
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true, code: true, zone: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);
    const billableMinutes = entries
      .filter((e) => e.isBillable)
      .reduce((sum, e) => sum + e.minutes, 0);

    return {
      date: dateStr,
      entries,
      summary: {
        totalMinutes,
        totalHours: +(totalMinutes / 60).toFixed(2),
        billableMinutes,
        billableHours: +(billableMinutes / 60).toFixed(2),
        entryCount: entries.length,
      },
    };
  }

  async getWeeklyGrid(userId: number, weekStartStr: string) {
    if (!weekStartStr) {
      return { weekStart: '', weekEnd: '', rows: [], dailyTotals: {}, weeklyTotal: 0 };
    }
    const weekStart = parseISO(weekStartStr);
    const weekEnd = addDays(weekStart, 6);

    // Use 1-day buffer on each side to handle timezone edge cases
    const queryStart = addDays(weekStart, -1);
    const queryEnd = addDays(weekEnd, 1);

    const allEntries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        deletedAt: null,
        date: { gte: startOfDay(queryStart), lte: endOfDay(queryEnd) },
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
    });

    // Build the 7 valid day keys for this week
    const validDayKeys = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      validDayKeys.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }

    // Filter entries to only those whose date falls within the 7-day week
    const entries = allEntries.filter((e) => {
      const d = new Date(e.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return validDayKeys.has(key);
    });

    const grid: Record<string, any> = {};

    for (const entry of entries) {
      const key = `${entry.projectId || 0}-${entry.taskId || 0}`;
      if (!grid[key]) {
        grid[key] = {
          projectId: entry.projectId,
          projectName: entry.project?.name || 'No Project',
          taskId: entry.taskId,
          taskName: entry.task?.name || 'No Task',
          days: {},
          totalMinutes: 0,
        };
      }

      // Use UTC-safe date key extraction to avoid timezone shifts
      const d = new Date(entry.date);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!grid[key].days[dayKey]) {
        grid[key].days[dayKey] = { minutes: 0, entries: [] };
      }
      grid[key].days[dayKey].minutes += entry.minutes;
      grid[key].days[dayKey].entries.push(entry);
      grid[key].totalMinutes += entry.minutes;
    }

    const dailyTotals: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailyTotals[dayKey] = entries
        .filter((e) => {
          const ed = new Date(e.date);
          return ed.getFullYear() === d.getFullYear() && ed.getMonth() === d.getMonth() && ed.getDate() === d.getDate();
        })
        .reduce((sum, e) => sum + e.minutes, 0);
    }

    return {
      weekStart: format(weekStart, 'yyyy-MM-dd'),
      weekEnd: format(weekEnd, 'yyyy-MM-dd'),
      rows: Object.values(grid),
      dailyTotals,
      weeklyTotal: entries.reduce((sum, e) => sum + e.minutes, 0),
    };
  }
}
