import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  async findAll(projectId: number) {
    return this.prisma.service.findMany({
      where: { projectId, deletedAt: null },
      include: {
        deliverables: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findOne(id: number) {
    const service = await this.prisma.service.findFirst({
      where: { id, deletedAt: null },
      include: {
        deliverables: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    return service;
  }

  async create(projectId: number, dto: CreateServiceDto) {
    return this.prisma.service.create({
      data: {
        projectId,
        ...dto,
      },
      include: {
        deliverables: true,
      },
    });
  }

  async update(id: number, dto: UpdateServiceDto) {
    await this.findOne(id);

    return this.prisma.service.update({
      where: { id },
      data: dto,
      include: {
        deliverables: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    await this.prisma.service.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Service deleted' };
  }
}
