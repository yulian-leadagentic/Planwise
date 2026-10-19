import { Injectable, NotFoundException } from '@nestjs/common';
import { CalendarDayType } from '@prisma/client';
import { parseISO } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateCalendarDayDto } from './dto/create-calendar-day.dto';

/**
 * HR Wave 2 G2 (2026-10-19) — defaults for `CalendarDay.workingHours`
 * when the caller omits an explicit value. Matches the type defaults
 * baked into the migration backfill: HOLIDAY_EVE / CHOL_HAMOED = 5h
 * (historical AMEC short-day), HOLIDAY / REST = 0h (person is off).
 * REGULAR rows never materialize via this service (the HR engine
 * defaults missing dates to REGULAR implicitly), so we leave them
 * null and let the engine's defaultForType pick user.dailyStandardHours.
 */
function defaultWorkingHoursForType(type: CalendarDayType): number | null {
  switch (type) {
    case CalendarDayType.HOLIDAY_EVE:
    case CalendarDayType.CHOL_HAMOED:
      return 5;
    case CalendarDayType.HOLIDAY:
    case CalendarDayType.REST:
      return 0;
    default:
      return null;
  }
}

@Injectable()
export class CalendarService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateCalendarDayDto) {
    // HR Wave 2 G2 (2026-10-19) — persist workingHours. If the caller
    // supplies an explicit value (FE calendar modal, hebcal import)
    // use it; otherwise fall back to the type default so the engine
    // reads a non-null value post-create too.
    const workingHours =
      dto.workingHours !== undefined
        ? dto.workingHours
        : defaultWorkingHoursForType(dto.type);
    return this.prisma.calendarDay.create({
      data: {
        date: new Date(dto.date),
        name: dto.name,
        type: dto.type,
        halfDayUntil: dto.halfDayUntil,
        workingHours,
        appliesTo: dto.appliesTo ?? 'all',
        isRecurring: dto.isRecurring ?? false,
        notes: dto.notes,
        createdBy: userId,
      },
    });
  }

  async findAll(from: string, to: string) {
    const where: any = {};
    if (from && to) {
      where.date = {
        gte: parseISO(from),
        lte: parseISO(to),
      };
    }

    return this.prisma.calendarDay.findMany({
      where,
      orderBy: { date: 'asc' },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async update(id: number, dto: Partial<CreateCalendarDayDto>) {
    const existing = await this.prisma.calendarDay.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Calendar day not found');
    }

    // HR Wave 2 G2 (2026-10-19) — explicit null clears the override
    // back to the type default (engine's defaultForType picks up the
    // slack); an omitted key preserves the stored value. The spread
    // handles that correctly, but spelling it out keeps the intent
    // obvious when someone grep-reads this file.
    return this.prisma.calendarDay.update({
      where: { id },
      data: {
        ...dto,
        date: dto.date ? new Date(dto.date) : undefined,
        workingHours:
          dto.workingHours === undefined ? undefined : dto.workingHours,
      },
    });
  }

  async remove(id: number) {
    await this.prisma.calendarDay.delete({ where: { id } });
    return { message: 'Calendar day deleted' };
  }
}
