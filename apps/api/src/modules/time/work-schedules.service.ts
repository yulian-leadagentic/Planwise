import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateWorkScheduleDto } from './dto/create-work-schedule.dto';

@Injectable()
export class WorkSchedulesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateWorkScheduleDto) {
    return this.prisma.workSchedule.create({
      data: {
        userId: dto.userId,
        name: dto.name,
        dayOfWeek: dto.dayOfWeek,
        shiftStart: dto.shiftStart,
        shiftEnd: dto.shiftEnd,
        breakMinutes: dto.breakMinutes ?? 60,
        isActive: dto.isActive ?? true,
        effectiveFrom: new Date(dto.effectiveFrom),
        effectiveUntil: dto.effectiveUntil ? new Date(dto.effectiveUntil) : null,
      },
    });
  }

  async findByUser(userId: number) {
    return this.prisma.workSchedule.findMany({
      where: { userId },
      orderBy: [{ dayOfWeek: 'asc' }, { effectiveFrom: 'desc' }],
    });
  }

  async update(id: number, dto: Partial<CreateWorkScheduleDto>) {
    const existing = await this.prisma.workSchedule.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Work schedule not found');
    }

    return this.prisma.workSchedule.update({
      where: { id },
      data: {
        ...dto,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined,
        effectiveUntil: dto.effectiveUntil ? new Date(dto.effectiveUntil) : undefined,
      },
    });
  }

  async remove(id: number) {
    await this.prisma.workSchedule.delete({ where: { id } });
    return { message: 'Work schedule deleted' };
  }
}
