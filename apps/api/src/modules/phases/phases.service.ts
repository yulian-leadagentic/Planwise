import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreatePhaseDto } from './dto/create-phase.dto';
import { UpdatePhaseDto } from './dto/update-phase.dto';

@Injectable()
export class PhasesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.phase.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  async create(dto: CreatePhaseDto) {
    const existing = await this.prisma.phase.findUnique({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(
        `Phase with name "${dto.name}" already exists`,
      );
    }

    return this.prisma.phase.create({
      data: {
        name: dto.name,
        code: dto.code ?? null,
        color: dto.color ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(id: number, dto: UpdatePhaseDto) {
    const phase = await this.prisma.phase.findUnique({
      where: { id },
    });

    if (!phase) {
      throw new NotFoundException(`Phase with id ${id} not found`);
    }

    return this.prisma.phase.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    const phase = await this.prisma.phase.findUnique({
      where: { id },
    });

    if (!phase) {
      throw new NotFoundException(`Phase with id ${id} not found`);
    }

    const taskCount = await this.prisma.task.count({
      where: { phaseId: id },
    });
    const templateCount = await this.prisma.template.count({
      where: { phaseId: id, deletedAt: null },
    });

    if (taskCount > 0 || templateCount > 0) {
      const refs: string[] = [];
      if (taskCount > 0) refs.push(`${taskCount} task(s)`);
      if (templateCount > 0) refs.push(`${templateCount} service template(s)`);
      throw new BadRequestException(
        `Cannot delete phase: ${refs.join(' and ')} still reference it`,
      );
    }

    await this.prisma.phase.delete({ where: { id } });

    return { message: 'Phase deleted' };
  }
}
