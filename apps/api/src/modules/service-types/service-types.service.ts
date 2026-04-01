import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateServiceTypeDto } from './dto/create-service-type.dto';
import { UpdateServiceTypeDto } from './dto/update-service-type.dto';

@Injectable()
export class ServiceTypesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.serviceType.findMany({
      orderBy: { sortOrder: 'asc' },
    });
  }

  async create(dto: CreateServiceTypeDto) {
    const existing = await this.prisma.serviceType.findUnique({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(
        `Service type with name "${dto.name}" already exists`,
      );
    }

    return this.prisma.serviceType.create({
      data: {
        name: dto.name,
        code: dto.code,
        color: dto.color,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(id: number, dto: UpdateServiceTypeDto) {
    const serviceType = await this.prisma.serviceType.findUnique({
      where: { id },
    });

    if (!serviceType) {
      throw new NotFoundException(`Service type with id ${id} not found`);
    }

    return this.prisma.serviceType.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    const serviceType = await this.prisma.serviceType.findUnique({
      where: { id },
    });

    if (!serviceType) {
      throw new NotFoundException(`Service type with id ${id} not found`);
    }

    const taskCount = await this.prisma.task.count({
      where: { serviceTypeId: id },
    });

    if (taskCount > 0) {
      throw new BadRequestException(
        `Cannot delete service type: ${taskCount} task(s) still reference it`,
      );
    }

    await this.prisma.serviceType.delete({ where: { id } });

    return { message: 'Service type deleted' };
  }
}
