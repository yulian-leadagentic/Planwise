import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { startOfDay, endOfDay, addDays, parseISO, format } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
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

    // QA4 B4 — defense in depth. A single-entry create MUST carry a
    // task (and, transitively, a project). The shared DTO stays lax
    // because the batch endpoint accepts partial rows, so we enforce
    // here instead of tightening the DTO for every call site. The
    // projectId derivation below runs after this guard, so a missing
    // projectId is still permitted when a taskId resolves to one.
    // The field list rides in `details` (2026-11-21) — the global
    // HttpExceptionFilter drops any other top-level key.
    if (!dto.taskId) {
      throw new BadRequestException({ message: 'Task is required', code: 'TIME_ENTRY_TASK_REQUIRED', details: { missing: ['taskId'] } });
    }

    // Auto-derive projectId from the task when the caller didn't pass it
    // (QuickTimeLog / TaskDrawer call sites historically did this
    // inconsistently — leaving a column that aggregations rely on
    // half-empty). Belt-and-suspenders: aggregations now also resolve
    // project membership via task.projectId, but keeping this column
    // populated keeps the data clean for any future direct queries.
    // Round 4 (D-08) — an explicit projectId must be the task's project.
    const projectId = await this.resolveEntryProject(dto.taskId, dto.projectId);

    // QA4 B4: after the task-derivation step every entry must have a
    // resolvable project. Personal tasks (task.projectId=null) can't
    // hit the timesheet — those go through Personal Task Dialog and
    // are logged against the user's Home clock, not this path.
    if (!projectId) {
      throw new BadRequestException({ message: 'Project is required', code: 'TIME_ENTRY_PROJECT_REQUIRED', details: { missing: ['projectId'] } });
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

    // HR §9.1 (2026-10-16): server-side bucket gate. The picker is UX
    // only; this is the real guard. Passes the authenticated userId
    // and the entry's local date so the eligibility check keys off the
    // actual work date (not "today") — a user retroactively logging a
    // B·REPORTED hour must still have been eligible on that day.
    if (dto.specialHourBucketId != null) {
      await this.assertUsableBucket(dto.specialHourBucketId, userId, localDate);
    }

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
        specialHourBucketId: dto.specialHourBucketId ?? null,
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

  /**
   * Round 4 (D-08) — an entry's project follows its task. Returns the
   * task's project; a different explicit `projectId` is a 400. A task
   * without a project (or no task) keeps the explicit value.
   */
  private async resolveEntryProject(
    taskId: number | null | undefined,
    projectId: number | null | undefined,
  ): Promise<number | null | undefined> {
    if (taskId == null) return projectId;
    const t = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (t?.projectId == null) return projectId;
    if (projectId != null && projectId !== t.projectId) {
      throw new BadRequestException({
        code: 'TIME_ENTRY_PROJECT_MISMATCH',
        message: "The selected task belongs to a different project than the one chosen for this time entry.",
      });
    }
    return t.projectId;
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
    // Round 3 (2026-11-22): soft-deleted entries are gone for every
    // reader. `task.projectId` rides along so the controller can apply
    // the project-leader rule to entries whose own projectId is NULL.
    const entry = await this.prisma.timeEntry.findFirst({
      where: { id, deletedAt: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true, projectId: true } },
      },
    });

    if (!entry) {
      throw new NotFoundException('Time entry not found');
    }

    return entry;
  }

  async update(id: number, dto: Partial<CreateTimeEntryDto>, userId?: number) {
    const existing = await this.findOne(id);

    // Ownership gate — a user with `time:write` must only PATCH their own
    // entries. @OwnData routing on the controller handles the common
    // path, but belt-and-suspenders at the service: fail-closed on any
    // caller != entry.owner before overlap/bucket checks (both of which
    // keyed off the row's owner and would silently leak another user's
    // calendar state through 409 messaging).
    if (userId != null && existing.userId !== userId) {
      throw new PermissionDeniedException('You can only edit your own time entries.', {
        module: 'time',
        reason: 'TIME_ENTRY_NOT_OWNER',
      });
    }

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

    // HR §9.1 (2026-10-16): server-side bucket gate on PATCH. The
    // ownership gate at the top of update() guarantees caller == owner,
    // so the eligibility check below keys off that single identity.
    if ('specialHourBucketId' in dto && dto.specialHourBucketId != null) {
      const mergedDateForBucket = dto.date ? mergedDate : existing.date;
      await this.assertUsableBucket(
        dto.specialHourBucketId,
        existing.userId,
        mergedDateForBucket,
      );
    }

    // Round 4 (D-08) — a new task or project keeps the entry's project
    // equal to its task's project. Echoed unchanged values pass as-is.
    const bindingChanged =
      (dto.taskId != null && dto.taskId !== existing.taskId) ||
      (dto.projectId != null && dto.projectId !== existing.projectId);
    const projectIdPatch = bindingChanged
      ? await this.resolveEntryProject(dto.taskId ?? existing.taskId, dto.projectId)
      : dto.projectId;

    // Explicit column whitelist (mirrors create() ~176). Spreading
    // ...dto pulls the non-column control flag `confirmOverlap` into
    // Prisma's update input, which trips the *checked* variant where
    // scalar `projectId`/`taskId` are rejected → TIME_ENTRIE-UPDATE-500.
    // Fields the PATCH did not send stay `undefined` → Prisma skips
    // them (partial-update semantics preserved). Overlap check runs
    // regardless, so dropping `confirmOverlap` here is safe.
    const updated = await this.prisma.timeEntry.update({
      where: { id },
      data: {
        timeClockId: dto.timeClockId,
        projectId: projectIdPatch,
        taskId: dto.taskId,
        date: dto.date ? mergedDate : undefined,
        startTime: dto.startTime,
        endTime: dto.endTime,
        minutes: dto.minutes,
        note: dto.note,
        isBillable: dto.isBillable,
        location: dto.location,
        completionPct: dto.completionPct,
        // Nullable: `specialHourBucketId: null` in the PATCH payload
        // clears the field; absence of the key leaves it untouched.
        specialHourBucketId:
          'specialHourBucketId' in dto ? (dto.specialHourBucketId ?? null) : undefined,
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

    // Ownership gate — same rule as update() (TIME_ENTRY_NOT_OWNER).
    if (userId != null && existing.userId !== userId) {
      throw new PermissionDeniedException('You can only delete your own time entries.', {
        module: 'time',
        reason: 'TIME_ENTRY_NOT_OWNER',
      });
    }

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
        deletedAt: null,
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

  /**
   * One user's week, day by day — the shared source of the week mode of
   * `GET /time-entries/daily` and of `GET /time-entries/weekly`, so the
   * two screens can't disagree.
   *
   * Per day:
   *   • entries   — live entries (optionally one project's);
   *   • presence  — clock records that are attendance (not absent /
   *                 leave / sick placeholders);
   *   • clocked   — minutes of the closed presence records, or null;
   *   • expected  — the work-schedule shift, unless the work calendar
   *                 says otherwise (a calendar day's `workingHours`, or
   *                 0 on HOLIDAY / REST) or the day is a leave / sick
   *                 record (0). No schedule → 0.
   *
   * The HR monthly review stays the authoritative computation; this is
   * the employee's indicative view.
   */
  private async loadWeek(userId: number, weekStartStr: string, opts: { projectId?: number } = {}) {
    const weekStart = parseISO(weekStartStr);
    if (Number.isNaN(weekStart.getTime())) {
      throw new BadRequestException('weekStart must be a date (YYYY-MM-DD)');
    }
    const weekEnd = addDays(weekStart, 6);
    const dayKey = (d: Date) => format(d, 'yyyy-MM-dd');

    // 1-day buffer each side for timezone edges; days are then keyed in
    // local time and anything outside the 7 days is dropped.
    const queryStart = startOfDay(addDays(weekStart, -1));
    const queryEnd = endOfDay(addDays(weekEnd, 1));
    const projectFilter =
      opts.projectId != null
        ? { OR: [{ projectId: opts.projectId }, { task: { projectId: opts.projectId } }] }
        : {};

    const [entries, clocks, schedules, calendarDays] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: { userId, deletedAt: null, date: { gte: queryStart, lte: queryEnd }, ...projectFilter },
        include: {
          project: { select: { id: true, name: true } },
          task: {
            select: {
              id: true,
              name: true,
              code: true,
              projectId: true,
              budgetHours: true,
              project: { select: { id: true, name: true } },
              zone: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.timeClock.findMany({
        where: { userId, date: { gte: queryStart, lte: queryEnd } },
        orderBy: { clockIn: 'asc' },
      }),
      this.prisma.workSchedule.findMany({
        where: {
          userId,
          isActive: true,
          effectiveFrom: { lte: endOfDay(weekEnd) },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: startOfDay(weekStart) } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.prisma.calendarDay.findMany({
        where: { date: { gte: queryStart, lte: queryEnd }, appliesTo: { in: ['all', 'employees_only'] } },
        select: { date: true, type: true, workingHours: true },
      }),
    ]);

    const NOT_PRESENCE = new Set(['absent', 'leave', 'sick']);
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(weekStart, i);
      const key = dayKey(day);
      const dayEntries = entries.filter((e) => dayKey(new Date(e.date)) === key);
      const dayClocks = clocks.filter((c) => dayKey(new Date(c.date)) === key);
      const presence = dayClocks.filter((c) => !NOT_PRESENCE.has(c.status));
      const onLeave = dayClocks.some((c) => c.status === 'leave' || c.status === 'sick');
      const closed = presence.filter((c) => c.totalMinutes != null);
      const clocked = closed.length > 0 ? closed.reduce((s, c) => s + (c.totalMinutes ?? 0), 0) : null;

      const schedule =
        schedules.find(
          (s) =>
            s.dayOfWeek === day.getDay() &&
            s.effectiveFrom <= endOfDay(day) &&
            (s.effectiveUntil == null || s.effectiveUntil >= startOfDay(day)),
        ) ?? null;
      const shiftMinutes = (() => {
        if (!schedule) return 0;
        const start = hhmmToMinutes(schedule.shiftStart);
        const end = hhmmToMinutes(schedule.shiftEnd);
        return start != null && end != null ? Math.max(0, end - start - schedule.breakMinutes) : 0;
      })();
      const calendar = calendarDays.find((c) => dayKey(new Date(c.date)) === key) ?? null;
      // No schedule → nothing expected. Otherwise the work calendar wins
      // (its working hours, or a day off), then leave / sick.
      let expectedMinutes = shiftMinutes;
      if (schedule && calendar?.workingHours != null) {
        expectedMinutes = Math.round(Number(calendar.workingHours) * 60);
      } else if (calendar && (calendar.type === 'HOLIDAY' || calendar.type === 'REST')) {
        expectedMinutes = 0;
      }
      if (onLeave) expectedMinutes = 0;

      return {
        key,
        entries: dayEntries,
        logged: dayEntries.reduce((s, e) => s + e.minutes, 0),
        presence,
        clocked,
        // A day off shows no shift at all.
        schedule: schedule && expectedMinutes > 0 ? schedule : null,
        expectedMinutes,
      };
    });
    return { weekStart, weekEnd, days };
  }

  /** A day's attendance span: first clock-in, last clock-out (null while a record is open). */
  private attendanceSpan(presence: Array<{ clockIn: Date; clockOut: Date | null }>) {
    if (presence.length === 0) return null;
    const clockIn = presence.reduce((min, c) => (c.clockIn < min ? c.clockIn : min), presence[0].clockIn);
    const open = presence.some((c) => c.clockOut == null);
    const clockOut = open
      ? null
      : presence.reduce<Date | null>((max, c) => (max == null || (c.clockOut as Date) > max ? c.clockOut : max), null);
    return { clockIn, clockOut };
  }

  /**
   * Week mode of `GET /time-entries/daily?weekStart=` — the shape the
   * web's My Time page renders (`DailyBreakdown[]` in @amec/shared):
   *
   *   • clock      — the day's attendance in the TimeClock shape: the
   *                  latest record, spanning the first clock-in to the
   *                  last clock-out (null while one is open) with the
   *                  day's clocked minutes — the same numbers as the
   *                  weekly grid's `clock`. Leave / sick / absent
   *                  placeholders are not a clock;
   *   • expected   — the shift of the work schedule, null on a holiday,
   *                  rest or leave day (see loadWeek);
   *   • difference — logged minus clocked minutes (all of the day's
   *                  closed attendance records); null when nothing was
   *                  clocked;
   *   • isBalanced — |difference| ≤ 15 minutes.
   */
  async getWeekDailyBreakdown(userId: number, weekStartStr: string) {
    const { days } = await this.loadWeek(userId, weekStartStr);
    return days.map((d) => {
      const difference = d.clocked != null ? d.logged - d.clocked : null;
      const span = this.attendanceSpan(d.presence);
      return {
        date: d.key,
        clock: span
          ? { ...d.presence[d.presence.length - 1], clockIn: span.clockIn, clockOut: span.clockOut, totalMinutes: d.clocked }
          : null,
        expected: d.schedule
          ? {
              shiftStart: d.schedule.shiftStart,
              shiftEnd: d.schedule.shiftEnd,
              breakMinutes: d.schedule.breakMinutes,
              expectedMinutes: d.expectedMinutes,
            }
          : null,
        entries: d.entries,
        totalLogged: d.logged,
        difference,
        isBalanced: difference != null && Math.abs(difference) <= 15,
      };
    });
  }

  /**
   * `GET /time-entries/weekly` — the shared `WeeklyGrid` shape
   * (@amec/shared) rendered by the Weekly Grid (/time/grid), the My Time
   * summary cards (/time/summary) and the Timesheet calendar (/time):
   *
   *   • rows        — one per task (`type: 'task'`) or per project for
   *                   task-less legacy entries (`type: 'project'`);
   *                   `days` has all 7 keys: null, or
   *                   `{ id, minutes, entries }` where `id` is the first
   *                   entry of the cell (the one the grid edits when the
   *                   cell holds a single entry) and `entries` the full
   *                   rows the Timesheet calendar draws;
   *   • clock       — per day with attendance: first clock-in, last
   *                   clock-out (null while one is open), clocked
   *                   minutes, expected minutes;
   *   • dailyTotals — all 7 days: logged, clocked (null if none), diff
   *                   (logged − clocked, null if nothing clocked);
   *   • weekSummary — totals; overtime / missing = net of worked −
   *                   expected over the days BEFORE today (today isn't
   *                   over), where worked = clocked minutes, or logged
   *                   minutes on a day without a closed clock record.
   *
   * `projectId` narrows the rows and the logged totals to one project;
   * clocked / expected minutes are attendance and stay whole.
   */
  async getWeeklyGrid(userId: number, weekStartStr: string, opts: { projectId?: number } = {}) {
    const emptySummary = { totalLogged: 0, totalClocked: 0, totalExpected: 0, overtimeMinutes: 0, missingMinutes: 0 };
    if (!weekStartStr) {
      return { weekStart: '', rows: [], clock: {}, dailyTotals: {}, weekSummary: emptySummary };
    }
    const { weekStart, days } = await this.loadWeek(userId, weekStartStr, opts);
    const dayKeys = days.map((d) => d.key);

    type Entry = (typeof days)[number]['entries'][number];
    const rowsByKey = new Map<string, { entries: Entry[]; first: Entry }>();
    for (const d of days) {
      for (const e of d.entries) {
        const projectId = e.projectId ?? e.task?.projectId ?? null;
        const key = e.taskId != null ? `t${e.taskId}` : `p${projectId ?? 0}`;
        const bucket = rowsByKey.get(key);
        if (bucket) bucket.entries.push(e);
        else rowsByKey.set(key, { entries: [e], first: e });
      }
    }

    const rows = [...rowsByKey.values()].map(({ entries, first }) => {
      const projectId = first.projectId ?? first.task?.projectId ?? undefined;
      const projectName = first.project?.name ?? first.task?.project?.name ?? 'No Project';
      const cells: Record<string, { id: number; minutes: number; entries: Entry[] } | null> = {};
      for (const key of dayKeys) {
        const inDay = entries.filter((e) => format(new Date(e.date), 'yyyy-MM-dd') === key);
        cells[key] =
          inDay.length === 0
            ? null
            : { id: inDay[0].id, minutes: inDay.reduce((s, e) => s + e.minutes, 0), entries: inDay };
      }
      const budget = first.task?.budgetHours;
      return {
        type: (first.taskId != null ? 'task' : 'project') as 'task' | 'project',
        ...(first.taskId != null ? { taskId: first.taskId, taskName: first.task?.name ?? 'Task' } : {}),
        ...(projectId != null ? { projectId } : {}),
        projectName,
        ...(first.task?.zone?.name ? { labelPath: `${projectName} / ${first.task.zone.name}` } : { labelPath: projectName }),
        days: cells,
        weekTotalMinutes: entries.reduce((s, e) => s + e.minutes, 0),
        ...(budget != null ? { budgetHours: Number(budget) } : {}),
      };
    });
    rows.sort(
      (a, b) =>
        a.projectName.localeCompare(b.projectName) ||
        String(a.taskName ?? '').localeCompare(String(b.taskName ?? '')),
    );

    const clock: Record<string, { clockIn: string; clockOut: string | null; totalMinutes: number | null; expectedMinutes: number | null }> = {};
    const dailyTotals: Record<string, { logged: number; clocked: number | null; diff: number | null }> = {};
    const todayKey = format(new Date(), 'yyyy-MM-dd');
    let totalLogged = 0;
    let totalClocked = 0;
    let totalExpected = 0;
    let net = 0;
    for (const d of days) {
      const span = this.attendanceSpan(d.presence);
      if (span) {
        clock[d.key] = {
          clockIn: span.clockIn.toISOString(),
          clockOut: span.clockOut ? span.clockOut.toISOString() : null,
          totalMinutes: d.clocked,
          expectedMinutes: d.presence.find((c) => c.expectedMinutes != null)?.expectedMinutes ?? d.expectedMinutes,
        };
      }
      dailyTotals[d.key] = {
        logged: d.logged,
        clocked: d.clocked,
        diff: d.clocked != null ? d.logged - d.clocked : null,
      };
      totalLogged += d.logged;
      totalClocked += d.clocked ?? 0;
      totalExpected += d.expectedMinutes;
      if (d.key < todayKey) net += (d.clocked ?? d.logged) - d.expectedMinutes;
    }

    return {
      weekStart: format(weekStart, 'yyyy-MM-dd'),
      rows,
      clock,
      dailyTotals,
      weekSummary: {
        totalLogged,
        totalClocked,
        totalExpected,
        overtimeMinutes: Math.max(0, net),
        missingMinutes: Math.max(0, -net),
      },
    };
  }

  /**
   * HR §9.1 (2026-10-16) — shared validator for the
   * `specialHourBucketId` field on create/update.
   *
   * The picker (`GET /hr/me/pickable-buckets`) is UX only. This is the
   * real gate — any client that reaches the write path (API client,
   * curl, legacy app) still has to clear it.
   *
   * Rejects:
   *   • unknown ids / inactive buckets (admin flipped `active=false`
   *     after a client cached the list) → `TIME_ENTRY_BUCKET_INACTIVE`
   *     (merged with NOT_FOUND — both mean "pick another bucket");
   *   • B·AUTO buckets — the HR engine credits these automatically
   *     per spec §3.6, so a user-reported row would double-count →
   *     `TIME_ENTRY_BUCKET_B_AUTO_NOT_REPORTABLE`;
   *   • B·REPORTED buckets reported by a user who has no active
   *     eligibility covering the entry's date →
   *     `TIME_ENTRY_BUCKET_B_NO_ELIGIBILITY`.
   *
   * Resolved mode for a B bucket = `eligibility.creditMode ??
   * bucket.defaultCreditMode`. Date comparison is inclusive on both
   * ends (`startDate <= entryDate <= endDate`).
   *
   * The error messages are in Hebrew to match this file's existing
   * conflict messaging (`SAME_TASK_OVERLAP`, `CROSS_TASK_OVERLAP`
   * remain English — those predate HR; new HR-shaped errors go HE to
   * match the HR module's existing voice).
   */
  private async assertUsableBucket(
    bucketId: number,
    userId: number,
    entryDate: Date,
  ) {
    const bucket = await this.prisma.specialHourBucket.findUnique({
      where: { id: bucketId },
      select: {
        id: true,
        code: true,
        active: true,
        behavior: true,
        defaultCreditMode: true,
      },
    });
    if (!bucket || !bucket.active) {
      throw new BadRequestException({
        message: bucket
          ? `הקטגוריה "${bucket.code}" אינה פעילה.`
          : `הקטגוריה המיוחדת (${bucketId}) לא נמצאה.`,
        code: 'TIME_ENTRY_BUCKET_INACTIVE',
      });
    }
    if (bucket.behavior !== 'B') {
      // A + C: always allowed when active.
      return;
    }

    // B behavior — eligibility required. We look up the caller's
    // active eligibility whose window brackets the entry's date.
    // `entryDate` carries a time component; the comparison still works
    // because Prisma's @db.Date values come back as midnight UTC and
    // the entry date was built as local midnight — both sides are
    // compared as full timestamps and the usual-case staging TZ keeps
    // local-midnight = UTC-midnight.
    const eligibility = await this.prisma.employeeBucketEligibility.findFirst({
      where: {
        userId,
        bucketId: bucket.id,
        active: true,
        startDate: { lte: entryDate },
        endDate: { gte: entryDate },
      },
      select: { id: true, creditMode: true },
    });

    if (!eligibility) {
      throw new BadRequestException({
        message:
          `אין לך זכאות פעילה לקטגוריה "${bucket.code}" בתאריך זה — פנה/י ל-HR לפתיחת זכאות.`,
        code: 'TIME_ENTRY_BUCKET_B_NO_ELIGIBILITY',
      });
    }

    const resolvedMode = eligibility.creditMode ?? bucket.defaultCreditMode;
    if (resolvedMode === 'AUTO') {
      // B·AUTO is auto-credited by the HR monthly engine (spec §3.6).
      // Reporting it manually would double-count.
      throw new BadRequestException({
        message:
          `הקטגוריה "${bucket.code}" מזוכה אוטומטית ע"י המערכת ולא ניתן לדווח עליה ידנית.`,
        code: 'TIME_ENTRY_BUCKET_B_AUTO_NOT_REPORTABLE',
      });
    }
  }
}
