import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';

interface AssignmentFilters {
  projectId?: number;
  zoneId?: number;
  deliverableId?: number;
  status?: string;
}

@Injectable()
export class AssignmentsService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters: AssignmentFilters) {
    const where: Prisma.AssignmentWhereInput = {
      deletedAt: null,
    };

    if (filters.deliverableId) {
      where.deliverableId = filters.deliverableId;
    }

    if (filters.zoneId) {
      where.zoneId = filters.zoneId;
    }

    if (filters.status) {
      where.status = filters.status as any;
    }

    if (filters.projectId) {
      where.deliverable = {
        deletedAt: null,
        service: {
          projectId: filters.projectId,
          deletedAt: null,
        },
      };
    }

    return this.prisma.assignment.findMany({
      where,
      include: {
        deliverable: { include: { service: true } },
        zone: true,
        assignees: {
          where: { deletedAt: null },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
        creator: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    const assignment = await this.prisma.assignment.findFirst({
      where: { id, deletedAt: null },
      include: {
        deliverable: { include: { service: true } },
        zone: true,
        assignees: {
          where: { deletedAt: null },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        },
        comments: {
          where: { deletedAt: null },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
              },
            },
            replies: {
              where: { deletedAt: null },
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    avatarUrl: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        creator: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }

    return assignment;
  }

  async create(userId: number, dto: CreateAssignmentDto) {
    // Verify deliverable exists
    const deliverable = await this.prisma.deliverable.findFirst({
      where: { id: dto.deliverableId, deletedAt: null },
    });

    if (!deliverable) {
      throw new NotFoundException('Deliverable not found');
    }

    // Verify zone if provided
    if (dto.zoneId) {
      const zone = await this.prisma.zone.findFirst({
        where: { id: dto.zoneId, deletedAt: null },
      });

      if (!zone) {
        throw new NotFoundException('Zone not found');
      }
    }

    return this.prisma.assignment.create({
      data: {
        deliverableId: dto.deliverableId,
        zoneId: dto.zoneId ?? null,
        name: dto.name,
        description: dto.description,
        status: dto.status ?? 'not_started',
        priority: dto.priority ?? 'medium',
        budgetHours: dto.budgetHours,
        budgetAmount: dto.budgetAmount,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        createdBy: userId,
      },
      include: {
        deliverable: true,
        zone: true,
        creator: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async update(id: number, dto: UpdateAssignmentDto) {
    await this.findOne(id);

    return this.prisma.assignment.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate !== undefined ? (dto.startDate ? new Date(dto.startDate) : null) : undefined,
        endDate: dto.endDate !== undefined ? (dto.endDate ? new Date(dto.endDate) : null) : undefined,
      },
      include: {
        deliverable: true,
        zone: true,
        assignees: {
          where: { deletedAt: null },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
        creator: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    await this.prisma.assignment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Assignment deleted' };
  }

  async addAssignee(assignmentId: number, userId: number, role?: string) {
    await this.findOne(assignmentId);

    const existing = await this.prisma.assignmentAssignee.findUnique({
      where: { assignmentId_userId: { assignmentId, userId } },
    });

    if (existing) {
      if (existing.deletedAt) {
        // Reactivate soft-deleted assignee
        return this.prisma.assignmentAssignee.update({
          where: { id: existing.id },
          data: { deletedAt: null, role },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
              },
            },
          },
        });
      }
      throw new ConflictException('User is already assigned');
    }

    return this.prisma.assignmentAssignee.create({
      data: { assignmentId, userId, role },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });
  }

  async removeAssignee(assignmentId: number, userId: number) {
    const assignee = await this.prisma.assignmentAssignee.findUnique({
      where: { assignmentId_userId: { assignmentId, userId } },
    });

    if (!assignee || assignee.deletedAt) {
      throw new NotFoundException('Assignee not found');
    }

    await this.prisma.assignmentAssignee.update({
      where: { id: assignee.id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Assignee removed' };
  }
}
