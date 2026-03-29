import { Injectable, NotFoundException } from '@nestjs/common';
import { startOfDay, endOfDay, addDays, parseISO, format } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';

@Injectable()
export class TimeEntriesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateTimeEntryDto) {
    return this.prisma.timeEntry.create({
      data: {
        userId,
        timeClockId: dto.timeClockId,
        projectId: dto.projectId,
        taskId: dto.taskId,
        date: new Date(dto.date),
        minutes: dto.minutes,
        note: dto.note,
        isBillable: dto.isBillable ?? true,
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
    });
  }

  async batchCreate(userId: number, entries: CreateTimeEntryDto[]) {
    const data = entries.map((dto) => ({
      userId,
      timeClockId: dto.timeClockId ?? null,
      projectId: dto.projectId ?? null,
      taskId: dto.taskId ?? null,
      date: new Date(dto.date),
      minutes: dto.minutes,
      note: dto.note ?? null,
      isBillable: dto.isBillable ?? true,
    }));

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
        date: dto.date ? new Date(dto.date) : undefined,
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
        task: { select: { id: true, name: true, label: { select: { name: true, path: true } } } },
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
    const weekStart = parseISO(weekStartStr);
    const weekEnd = addDays(weekStart, 6);

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: startOfDay(weekStart), lte: endOfDay(weekEnd) },
      },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
    });

    // Build grid: rows = project/task combos, columns = days
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

      const dayKey = format(entry.date, 'yyyy-MM-dd');
      if (!grid[key].days[dayKey]) {
        grid[key].days[dayKey] = { minutes: 0, entries: [] };
      }
      grid[key].days[dayKey].minutes += entry.minutes;
      grid[key].days[dayKey].entries.push(entry);
      grid[key].totalMinutes += entry.minutes;
    }

    // Build daily totals
    const dailyTotals: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      const dayKey = format(addDays(weekStart, i), 'yyyy-MM-dd');
      dailyTotals[dayKey] = entries
        .filter((e) => format(e.date, 'yyyy-MM-dd') === dayKey)
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
