import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateDeliverableDto } from './dto/create-deliverable.dto';
import { UpdateDeliverableDto } from './dto/update-deliverable.dto';

@Injectable()
export class DeliverablesService {
  constructor(private prisma: PrismaService) {}

  async findAll(serviceId: number) {
    return this.prisma.deliverable.findMany({
      where: { serviceId, deletedAt: null },
      include: {
        assignments: { where: { deletedAt: null } },
        zoneAssignments: { include: { zone: true } },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findOne(id: number) {
    const deliverable = await this.prisma.deliverable.findFirst({
      where: { id, deletedAt: null },
      include: {
        service: true,
        assignments: { where: { deletedAt: null } },
        zoneAssignments: { include: { zone: true } },
      },
    });

    if (!deliverable) {
      throw new NotFoundException('Deliverable not found');
    }

    return deliverable;
  }

  async create(serviceId: number, dto: CreateDeliverableDto) {
    // Verify service exists
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, deletedAt: null },
    });

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    return this.prisma.deliverable.create({
      data: {
        serviceId,
        name: dto.name,
        code: dto.code,
        percentage: dto.percentage,
        scope: dto.scope,
        description: dto.description,
        budgetHours: dto.budgetHours,
      },
      include: { service: true },
    });
  }

  async update(id: number, dto: UpdateDeliverableDto) {
    await this.findOne(id);

    return this.prisma.deliverable.update({
      where: { id },
      data: {
        ...dto,
        budgetHours: dto.budgetHours !== undefined ? dto.budgetHours : undefined,
      },
      include: { service: true },
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    await this.prisma.deliverable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Deliverable deleted' };
  }

  async linkZones(deliverableId: number, zoneIds: number[]) {
    await this.findOne(deliverableId);

    // Remove existing zone assignments for this deliverable
    await this.prisma.zoneAssignment.deleteMany({
      where: { deliverableId },
    });

    // Create new zone assignments
    const data = zoneIds.map((zoneId, index) => ({
      zoneId,
      deliverableId,
      isPrimary: index === 0,
    }));

    await this.prisma.zoneAssignment.createMany({ data });

    return this.prisma.zoneAssignment.findMany({
      where: { deliverableId },
      include: { zone: true },
    });
  }

  async instantiate(deliverableId: number, userId: number) {
    const deliverable = await this.prisma.deliverable.findFirst({
      where: { id: deliverableId, deletedAt: null },
      include: {
        zoneAssignments: { include: { zone: true } },
      },
    });

    if (!deliverable) {
      throw new NotFoundException('Deliverable not found');
    }

    const createdAssignments = [];

    if (deliverable.scope === 'per_zone') {
      for (const za of deliverable.zoneAssignments) {
        // Check if assignment already exists for this deliverable + zone
        const existing = await this.prisma.assignment.findFirst({
          where: {
            deliverableId,
            zoneId: za.zoneId,
            deletedAt: null,
          },
        });

        if (!existing) {
          const assignment = await this.prisma.assignment.create({
            data: {
              deliverableId,
              zoneId: za.zoneId,
              name: `${deliverable.name} - ${za.zone.name}`,
              status: 'not_started',
              priority: 'medium',
              budgetHours: deliverable.budgetHours,
              createdBy: userId,
            },
            include: {
              zone: true,
              deliverable: true,
            },
          });
          createdAssignments.push(assignment);
        }
      }
    } else {
      // For project-scope deliverables, create a single assignment
      const existing = await this.prisma.assignment.findFirst({
        where: {
          deliverableId,
          zoneId: null,
          deletedAt: null,
        },
      });

      if (!existing) {
        const assignment = await this.prisma.assignment.create({
          data: {
            deliverableId,
            name: deliverable.name,
            status: 'not_started',
            priority: 'medium',
            budgetHours: deliverable.budgetHours,
            createdBy: userId,
          },
          include: {
            deliverable: true,
          },
        });
        createdAssignments.push(assignment);
      }
    }

    return createdAssignments;
  }
}
