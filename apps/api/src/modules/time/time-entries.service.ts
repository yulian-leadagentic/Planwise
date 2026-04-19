import { Injectable, NotFoundException } from '@nestjs/common';
import { startOfDay, endOfDay, addDays, parseISO, format } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';

@Injectable()
export class TimeEntriesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateTimeEntryDto) {
    // Parse date as local midnight (not UTC) to avoid timezone issues
    const dateParts = dto.date.split('-').map(Number);
    const localDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);

    return this.prisma.timeEntry.create({
      data: {
        userId,
        timeClockId: dto.timeClockId,
        projectId: dto.projectId,
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
  }

  async batchCreate(userId: number, entries: CreateTimeEntryDto[]) {
    const data = entries.map((dto) => {
      const dp = dto.date.split('-').map(Number);
      return {
        userId,
        timeClockId: dto.timeClockId ?? null,
        projectId: dto.projectId ?? null,
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

  async update(id: number, dto: Partial<CreateTimeEntryDto>) {
    await this.findOne(id);

    return this.prisma.timeEntry.update({
      where: { id },
      data: {
        ...dto,
        date: dto.date ? (() => { const dp = dto.date.split('-').map(Number); return new Date(dp[0], dp[1] - 1, dp[2]); })() : undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.timeEntry.delete({ where: { id } });
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
