import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { differenceInMinutes, startOfDay, endOfDay, format, parseISO } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { ClockInDto } from './dto/clock-in.dto';
import { ClockOutDto } from './dto/clock-out.dto';

@Injectable()
export class TimeClockService {
  constructor(private prisma: PrismaService) {}

  async clockIn(userId: number, dto: ClockInDto) {
    const today = startOfDay(new Date());

    // Check if already clocked in today
    const existing = await this.prisma.timeClock.findFirst({
      where: { userId, date: today },
    });

    if (existing && !existing.clockOut) {
      throw new BadRequestException('Already clocked in today');
    }

    if (existing && existing.clockOut) {
      throw new BadRequestException('Already completed clock for today');
    }

    const now = new Date();

    // Check user schedule for late detection
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

    let isLate = false;
    let lateMinutes = 0;
    let expectedMinutes: number | null = null;

    if (schedule) {
      const [shiftHour, shiftMin] = schedule.shiftStart.split(':').map(Number);
      const shiftStart = new Date(today);
      shiftStart.setHours(shiftHour, shiftMin, 0, 0);

      if (now > shiftStart) {
        isLate = true;
        lateMinutes = differenceInMinutes(now, shiftStart);
      }

      const [endHour, endMin] = schedule.shiftEnd.split(':').map(Number);
      const shiftEnd = new Date(today);
      shiftEnd.setHours(endHour, endMin, 0, 0);

      expectedMinutes = differenceInMinutes(shiftEnd, shiftStart) - schedule.breakMinutes;
    }

    return this.prisma.timeClock.create({
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
  }

  async clockOut(userId: number, dto: ClockOutDto) {
    const today = startOfDay(new Date());

    const record = await this.prisma.timeClock.findFirst({
      where: { userId, date: today, clockOut: null },
    });

    if (!record) {
      throw new BadRequestException('No active clock-in found for today');
    }

    const now = new Date();
    const totalMinutes = differenceInMinutes(now, record.clockIn) - (dto.breakMinutes ?? record.breakMinutes);
    const overtimeMinutes = record.expectedMinutes
      ? Math.max(0, totalMinutes - record.expectedMinutes)
      : 0;

    return this.prisma.timeClock.update({
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
  }

  async getStatus(userId: number) {
    const today = startOfDay(new Date());

    const record = await this.prisma.timeClock.findFirst({
      where: { userId, date: today },
    });

    if (!record) {
      return { isClockedIn: false, record: null };
    }

    return {
      isClockedIn: !record.clockOut,
      record,
    };
  }

  async getDashboardToday(userId: number) {
    const today = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const [clockRecord, timeEntries, schedule] = await Promise.all([
      this.prisma.timeClock.findFirst({ where: { userId, date: today } }),
      this.prisma.timeEntry.findMany({
        where: { userId, date: { gte: today, lte: todayEnd } },
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

    return {
      clock: clockRecord,
      timeEntries,
      schedule,
      summary: {
        totalLoggedMinutes,
        totalLoggedHours: +(totalLoggedMinutes / 60).toFixed(2),
        expectedMinutes: clockRecord?.expectedMinutes ?? null,
      },
    };
  }

  async getHistory(userId: number, from: string, to: string) {
    const where: any = {};
    if (userId) where.userId = Number(userId);
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

  async editRecord(id: number, editorId: number, data: any) {
    const record = await this.prisma.timeClock.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('Time clock record not found');
    }

    const updateData: any = {
      status: 'edited',
      editedBy: editorId,
      editedReason: data.reason,
    };

    if (data.clockIn) updateData.clockIn = new Date(data.clockIn);
    if (data.clockOut) updateData.clockOut = new Date(data.clockOut);
    if (data.breakMinutes !== undefined) updateData.breakMinutes = data.breakMinutes;
    if (data.note !== undefined) updateData.note = data.note;

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

  async approveRecord(id: number, approverId: number) {
    return this.prisma.timeClock.update({
      where: { id },
      data: { approvedBy: approverId, approvedAt: new Date() },
    });
  }

  async markAbsent(userId: number, dateStr: string, note?: string) {
    const date = startOfDay(parseISO(dateStr));

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
