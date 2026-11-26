import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreatePhaseDto } from './dto/create-phase.dto';
import { UpdatePhaseDto } from './dto/update-phase.dto';
import { isPickableService } from './service-phase-rule';

@Injectable()
export class PhasesService {
  constructor(private prisma: PrismaService) {}

  /**
   * PR-069 — `scope: 'services'` returns only the rows that belong in a
   * Service picker (active `service` rows that are not a project
   * lifecycle phase, see `isPickableService`). The default stays every
   * row: lookups and filters still need the phase rows tasks point at.
   */
  async findAll(scope: 'all' | 'services' = 'all') {
    const rows = await this.prisma.phase.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return scope === 'services' ? rows.filter(isPickableService) : rows;
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

    const { requiredProfessionIds, ...rest } = dto;
    const data: Prisma.PhaseUpdateInput = { ...rest };
    if (requiredProfessionIds !== undefined) {
      data.requiredProfessionIds = await this.resolveRequiredProfessions(requiredProfessionIds);
    }

    return this.prisma.phase.update({
      where: { id },
      data,
    });
  }

  /**
   * QA6 PR-063 — `requiredProfessionIds` as stored: distinct, sorted
   * profession ids, or DB NULL for "no requirement" (null / []). Every id
   * must be an existing profession.
   */
  private async resolveRequiredProfessions(raw: unknown): Promise<Prisma.InputJsonValue | typeof Prisma.DbNull> {
    if (raw == null) return Prisma.DbNull;
    if (!Array.isArray(raw)) {
      throw new BadRequestException({
        code: 'PROFESSION_IDS_INVALID',
        message: 'requiredProfessionIds must be a list of qualification ids, or null.',
      });
    }
    const ids = [...new Set(raw.map(Number))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new BadRequestException({
        code: 'PROFESSION_IDS_INVALID',
        message: 'requiredProfessionIds must contain positive whole numbers only.',
      });
    }
    if (ids.length === 0) return Prisma.DbNull;
    const found = await this.prisma.profession.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const known = new Set(found.map((p) => p.id));
    const missing = ids.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'PROFESSION_NOT_FOUND',
        message: `Unknown qualification id(s): ${missing.join(', ')}.`,
        details: { missing },
      });
    }
    return ids.sort((a, b) => a - b);
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
