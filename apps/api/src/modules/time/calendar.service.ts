import { Injectable, NotFoundException } from '@nestjs/common';
import { parseISO } from 'date-fns';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateCalendarDayDto } from './dto/create-calendar-day.dto';

@Injectable()
export class CalendarService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateCalendarDayDto) {
    return this.prisma.calendarDay.create({
      data: {
        date: new Date(dto.date),
        name: dto.name,
        type: dto.type,
        halfDayUntil: dto.halfDayUntil,
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

    return this.prisma.calendarDay.update({
      where: { id },
      data: {
        ...dto,
        date: dto.date ? new Date(dto.date) : undefined,
      },
    });
  }

  async remove(id: number) {
    await this.prisma.calendarDay.delete({ where: { id } });
    return { message: 'Calendar day deleted' };
  }
}
