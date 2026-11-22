import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { differenceInMinutes, startOfDay, endOfDay, parseISO } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import {
  EmployeeScopeService,
  VisibleUserIds,
  notInManagerChain,
} from '../../common/services/employee-scope.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { ClockInDto } from './dto/clock-in.dto';
import { ClockOutDto } from './dto/clock-out.dto';
import * as Sentry from '@sentry/node';

/** The request user acting on someone's attendance (id + roleModules). */
type AttendanceActor = { id: number } & Record<string, any>;

@Injectable()
export class TimeClockService {
  constructor(
    private prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
    private readonly employeeScope: EmployeeScopeService,
  ) {}

  async clockIn(userId: number, dto: ClockInDto) {
    const today = startOfDay(new Date());

    // Only block if there's an OPEN clock-in (user forgot to clock out)
    const openRecord = await this.prisma.timeClock.findFirst({
      where: { userId, date: today, clockOut: null, status: 'clocked_in' },
    });

    if (openRecord) {
      throw new BadRequestException('Already clocked in — clock out first');
    }

    const now = new Date();

    // Check user schedule for late detection (only applied to the first clock-in of the day)
    const dayOfWeek = now.getDay();
    const schedule = await this.prisma.workSchedule.findFirst({
      where: {
        userId,
        dayOfWeek,
        isActive: true,
        effectiveFrom: { lte: now },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: now } }],
      },
    });

    // Count existing clock-in records for today to determine if this is the first one
    const existingTodayCount = await this.prisma.timeClock.count({
      where: { userId, date: today },
    });
    const isFirstClockInToday = existingTodayCount === 0;

    let isLate = false;
    let lateMinutes = 0;
    let expectedMinutes: number | null = null;

    if (schedule) {
      const [shiftHour, shiftMin] = schedule.shiftStart.split(':').map(Number);
      const shiftStart = new Date(today);
      shiftStart.setHours(shiftHour, shiftMin, 0, 0);

      // Only mark as late on the first clock-in of the day
      if (isFirstClockInToday && now > shiftStart) {
        isLate = true;
        lateMinutes = differenceInMinutes(now, shiftStart);
      }

      const [endHour, endMin] = schedule.shiftEnd.split(':').map(Number);
      const shiftEnd = new Date(today);
      shiftEnd.setHours(endHour, endMin, 0, 0);

      // Only attach expected minutes to the first clock-in of the day
      if (isFirstClockInToday) {
        expectedMinutes = differenceInMinutes(shiftEnd, shiftStart) - schedule.breakMinutes;
      }
    }

    const record = await this.prisma.timeClock.create({
      data: {
        userId,
        date: today,
        clockIn: now,
        status: 'clocked_in',
        clockType: dto.clockType || 'regular',
        note: dto.note,
        isLate,
        lateMinutes,
        expectedMinutes,
      },
    });

    try {
      await this.activityLog.write({
        category: 'time',
        action: 'time.clock.in',
        actorUserId: userId,
        projectId: null,
        entityType: 'time_clock',
        entityId: record.id,
        // Round 3 (2026-11-22): no lateness in the general activity log
        // (department leads read it). Lateness stays on the record
        // (isLate / lateMinutes), behind the attendance rules.
        description: 'Clocked in',
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return record;
  }

  async clockOut(userId: number, dto: ClockOutDto) {
    const today = startOfDay(new Date());

    // Find the most recent open clock-in for today
    const record = await this.prisma.timeClock.findFirst({
      where: { userId, date: today, clockOut: null, status: 'clocked_in' },
      orderBy: { clockIn: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('No active clock-in found for today');
    }

    const now = new Date();
    const totalMinutes = differenceInMinutes(now, record.clockIn) - (dto.breakMinutes ?? record.breakMinutes);
    const overtimeMinutes = record.expectedMinutes
      ? Math.max(0, totalMinutes - record.expectedMinutes)
      : 0;

    const closed = await this.prisma.timeClock.update({
      where: { id: record.id },
      data: {
        clockOut: now,
        breakMinutes: dto.breakMinutes ?? record.breakMinutes,
        status: 'completed',
        note: dto.note ?? record.note,
        totalMinutes: Math.max(0, totalMinutes),
        overtimeMinutes,
      },
    });

    try {
      await this.activityLog.write({
        category: 'time',
        action: 'time.clock.out',
        actorUserId: userId,
        projectId: null,
        entityType: 'time_clock',
        entityId: closed.id,
        // Round 3 (2026-11-22): no hours worked or overtime in the
        // general activity log — that is attendance data and department
        // leads read the log. The numbers stay on the clock record.
        description: 'Clocked out',
      });
    } catch (e) { Sentry.captureException(e); /* swallow */ }

    return closed;
  }

  async getStatus(userId: number) {
    const today = startOfDay(new Date());

    // Find the most recent record for today
    const record = await this.prisma.timeClock.findFirst({
      where: { userId, date: today },
      orderBy: { clockIn: 'desc' },
    });

    if (!record) {
      return {
        isClockedIn: false,
        clockInAt: null,
        elapsedMinutes: null,
        expectedMinutes: null,
        todayRecord: null,
      };
    }

    const isClockedIn = !record.clockOut;
    const elapsedMinutes = isClockedIn
      ? Math.max(0, differenceInMinutes(new Date(), record.clockIn))
      : record.totalMinutes ?? null;

    return {
      isClockedIn,
      clockInAt: record.clockIn.toISOString(),
      elapsedMinutes,
      expectedMinutes: record.expectedMinutes,
      todayRecord: record,
    };
  }

  /**
   * Team-wide "today" dashboard powering /time/clock-dashboard and
   * /admin/clock-dashboard. Returns the four buckets the UI renders:
   * who's currently clocked in, who has a schedule today but hasn't
   * clocked in yet, who clocked in late, and who is on leave/sick/absent
   * for the day.
   *
   * Permissions round 3 (2026-11-22): only employees in `visible`
   * (EmployeeScopeService.visibleUserIds — `'all'` for hr:read, else
   * self + current subordinates), the "not yet" list built from work
   * schedules included. `scope` tells the page whether the caller sees
   * everyone and how many people besides himself. Missing `visible` =
   * nobody (fail closed).
   *
   * Kept intentionally simple: a single pass per bucket, no joins more
   * than one level deep, no overtime/break math (the page only shows
   * names + state). Late = TimeClock.isLate flag on a clocked_in record.
   * On leave = TimeClock with status in (absent|leave|sick).
   */
  async getTeamDashboardToday(visible: VisibleUserIds = [], callerId?: number) {
    const today = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    const dayOfWeek = new Date().getDay();

    const userSelect = {
      id: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    } as const;

    const userFilter = visible === 'all' ? {} : { userId: { in: visible } };
    const scope = {
      allEmployees: visible === 'all',
      visibleOthers: visible === 'all' ? null : visible.filter((id) => id !== callerId).length,
    };
    if (visible !== 'all' && visible.length === 0) {
      return { clockedIn: [], notYet: [], late: [], onLeave: [], scope };
    }

    // Records for today, joined with user — one query, partitioned in JS.
    const records = await this.prisma.timeClock.findMany({
      where: { date: { gte: today, lte: todayEnd }, ...userFilter },
      include: { user: { select: userSelect } },
      orderBy: { clockIn: 'asc' },
    });

    const clockedIn = records.filter(
      (r) => r.status === 'clocked_in' && r.clockOut === null,
    );
    const late = records.filter((r) => r.isLate && r.lateMinutes > 0);
    const onLeave = records.filter(
      (r) => r.status === 'absent' || r.status === 'leave' || r.status === 'sick',
    );

    // "Not yet" = visible users with an active schedule for this
    // day-of-week who don't have any TimeClock row today.
    const schedulesToday = await this.prisma.workSchedule.findMany({
      where: {
        dayOfWeek,
        isActive: true,
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: new Date() } }],
        user: { isActive: true },
        ...userFilter,
      },
      include: { user: { select: userSelect } },
    });
    const userIdsWithRecord = new Set(records.map((r) => r.userId));
    const notYet = schedulesToday
      .filter((s) => !userIdsWithRecord.has(s.userId))
      .map((s) => ({ user: s.user, expectedShiftStart: s.shiftStart }));

    return { clockedIn, notYet, late, onLeave, scope };
  }

  async getDashboardToday(userId: number) {
    const today = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const [clockRecords, timeEntries, schedule] = await Promise.all([
      this.prisma.timeClock.findMany({
        where: { userId, date: today },
        orderBy: { clockIn: 'asc' },
      }),
      this.prisma.timeEntry.findMany({
        where: { userId, deletedAt: null, date: { gte: today, lte: todayEnd } },
        include: {
          project: { select: { id: true, name: true } },
          task: { select: { id: true, name: true } },
        },
      }),
      this.prisma.workSchedule.findFirst({
        where: {
          userId,
          dayOfWeek: new Date().getDay(),
          isActive: true,
          effectiveFrom: { lte: new Date() },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: new Date() } }],
        },
      }),
    ]);

    const totalLoggedMinutes = timeEntries.reduce((sum, e) => sum + e.minutes, 0);
    const totalClockedMinutes = clockRecords.reduce((sum, r) => sum + (r.totalMinutes ?? 0), 0);
    const expectedMinutes = clockRecords.find((r) => r.expectedMinutes != null)?.expectedMinutes ?? null;
    // Most recent record for backwards-compat `clock` field
    const latestRecord = clockRecords.length > 0 ? clockRecords[clockRecords.length - 1] : null;

    return {
      clock: latestRecord,
      clockRecords,
      timeEntries,
      schedule,
      summary: {
        totalLoggedMinutes,
        totalLoggedHours: +(totalLoggedMinutes / 60).toFixed(2),
        totalClockedMinutes,
        expectedMinutes,
      },
    };
  }

  /**
   * Clock records in a date range. Round 3 (2026-11-22): the controller
   * decides who the caller may see — a `userId` it already checked with
   * canViewEmployee, or (no userId) every user in `visible`. Missing
   * `visible` = nobody (fail closed).
   */
  async getHistory(
    userId: number | null | undefined,
    from: string,
    to: string,
    visible: VisibleUserIds = [],
  ) {
    const where: any = {};
    if (userId) where.userId = Number(userId);
    else if (visible !== 'all') where.userId = { in: visible };
    if (from) where.date = { ...where.date, gte: parseISO(from) };
    if (to) where.date = { ...where.date, lte: parseISO(to) };

    return this.prisma.timeClock.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        approver: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  /**
   * Edit someone else's clock record. Round 3 (2026-11-22): `hr:write`
   * or the manager chain (EmployeeScopeService.canEditAttendance), never
   * one's own record. An edit clears the approval — the approver signed
   * off on different times.
   */
  async editRecord(id: number, editor: AttendanceActor, data: any) {
    const record = await this.prisma.timeClock.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('Time clock record not found');
    }
    await this.assertCanEditAttendance(editor, record.userId);

    const body = data ?? {};
    const updateData: any = {
      status: 'edited',
      editedBy: editor.id,
      editedReason: body.reason,
      approvedBy: null,
      approvedAt: null,
    };

    if (body.clockIn) updateData.clockIn = new Date(body.clockIn);
    if (body.clockOut) updateData.clockOut = new Date(body.clockOut);
    if (body.breakMinutes !== undefined) updateData.breakMinutes = body.breakMinutes;
    if (body.note !== undefined) updateData.note = body.note;

    // Recalculate totals
    const clockIn = updateData.clockIn || record.clockIn;
    const clockOut = updateData.clockOut || record.clockOut;
    if (clockIn && clockOut) {
      const breakMin = updateData.breakMinutes ?? record.breakMinutes;
      updateData.totalMinutes = Math.max(0, differenceInMinutes(clockOut, clockIn) - breakMin);
      if (record.expectedMinutes) {
        updateData.overtimeMinutes = Math.max(0, updateData.totalMinutes - record.expectedMinutes);
      }
    }

    return this.prisma.timeClock.update({ where: { id }, data: updateData });
  }

  /**
   * Round 3 (2026-11-22): the record must exist (404); `hr:approve` or
   * the manager chain (EmployeeScopeService.canApproveAttendance); never
   * the record's own employee.
   */
  async approveRecord(id: number, approver: AttendanceActor) {
    const record = await this.prisma.timeClock.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!record) {
      throw new NotFoundException('Time clock record not found');
    }
    if (record.userId === approver.id) {
      throw new PermissionDeniedException(
        "You can't approve your own attendance record — your manager or HR approves it.",
        { reason: 'SELF_APPROVAL' },
      );
    }
    if (!(await this.employeeScope.canApproveAttendance(approver, record.userId))) {
      throw notInManagerChain('attendance', 'approve');
    }
    return this.prisma.timeClock.update({
      where: { id },
      data: { approvedBy: approver.id, approvedAt: new Date() },
    });
  }

  /** Round 3 (2026-11-22): same rule as editRecord — hr:write or the manager chain, never oneself. */
  async markAbsent(actor: AttendanceActor, userId: number, dateStr: string, note?: string) {
    await this.assertCanEditAttendance(actor, userId);
    const date = startOfDay(parseISO(dateStr));
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('date must be a date (YYYY-MM-DD)');
    }

    const existing = await this.prisma.timeClock.findFirst({
      where: { userId, date },
    });

    if (existing) {
      throw new BadRequestException('A record already exists for this date');
    }

    return this.prisma.timeClock.create({
      data: {
        userId,
        date,
        clockIn: date, // placeholder
        status: 'absent',
        note,
        totalMinutes: 0,
      },
    });
  }

  private async assertCanEditAttendance(actor: AttendanceActor, targetUserId: number): Promise<void> {
    if (targetUserId === actor.id) {
      throw new PermissionDeniedException(
        "You can't change your own attendance record — ask your manager or HR.",
        { reason: 'SELF_EDIT' },
      );
    }
    if (!(await this.employeeScope.canEditAttendance(actor, targetUserId))) {
      throw notInManagerChain('attendance', 'change');
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async autoCloseOpenClocks() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStart = startOfDay(yesterday);

    const openClocks = await this.prisma.timeClock.findMany({
      where: {
        date: { lt: yesterdayStart },
        clockOut: null,
        status: 'clocked_in',
      },
    });

    for (const clock of openClocks) {
      const endOfClockDay = endOfDay(clock.date);
      const totalMinutes = differenceInMinutes(endOfClockDay, clock.clockIn) - clock.breakMinutes;

      await this.prisma.timeClock.update({
        where: { id: clock.id },
        data: {
          clockOut: endOfClockDay,
          status: 'auto_closed',
          totalMinutes: Math.max(0, totalMinutes),
          overtimeMinutes: clock.expectedMinutes
            ? Math.max(0, totalMinutes - clock.expectedMinutes)
            : 0,
        },
      });
    }
  }
}
