import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateTaskDto) {
    const zone = await this.prisma.zone.findFirst({ where: { id: dto.zoneId } });
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    // If serviceTypeId provided, upsert the ZoneServiceType junction row
    if (dto.serviceTypeId) {
      await this.prisma.zoneServiceType.upsert({
        where: {
          zoneId_serviceTypeId: {
            zoneId: dto.zoneId,
            serviceTypeId: dto.serviceTypeId,
          },
        },
        create: {
          zoneId: dto.zoneId,
          serviceTypeId: dto.serviceTypeId,
        },
        update: {},
      });
    }

    return this.prisma.task.create({
      data: {
        zoneId: dto.zoneId,
        projectId: zone.projectId,
        serviceTypeId: dto.serviceTypeId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        budgetHours: dto.budgetHours,
        budgetAmount: dto.budgetAmount,
        phaseId: dto.phaseId,
        priority: dto.priority as any,
        createdBy: userId,
      },
      include: {
        zone: true,
        serviceType: true,
        phase: true,
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async findAll(query: QueryTasksDto) {
    const where: Prisma.TaskWhereInput = {
      deletedAt: null,
    };

    if (query.projectId) where.projectId = query.projectId;
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.serviceTypeId) where.serviceTypeId = query.serviceTypeId;
    if (query.phaseId) where.phaseId = query.phaseId;
    if (query.status) where.status = query.status as any;
    if (query.priority) where.priority = query.priority as any;
    if (query.assigneeId) {
      where.assignees = { some: { userId: query.assigneeId } };
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { code: { contains: query.search } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: 'desc' },
        include: {
          zone: { select: { id: true, name: true } },
          serviceType: { select: { id: true, name: true, code: true, color: true } },
          phase: { select: { id: true, name: true } },
          assignees: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
            },
          },
          dependencies: { include: { dependsOn: { select: { id: true, code: true, name: true } } } },
          _count: { select: { comments: true, timeEntries: true } },
        },
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        totalPages: Math.ceil(total / (query.perPage ?? 20)),
      },
    };
  }

  async findMine(userId: number) {
    return this.prisma.task.findMany({
      where: {
        deletedAt: null,
        assignees: { some: { userId } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        zone: { select: { id: true, name: true } },
        serviceType: { select: { id: true, name: true, code: true, color: true } },
        phase: { select: { id: true, name: true } },
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async findOne(id: number) {
    const task = await this.prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: {
        zone: true,
        project: true,
        serviceType: true,
        phase: true,
        creator: { select: { id: true, firstName: true, lastName: true } },
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          },
        },
        comments: {
          where: { parentId: null },
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
            replies: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        dependencies: { include: { dependsOn: { select: { id: true, code: true, name: true } } } },
        dependedBy: { include: { task: { select: { id: true, code: true, name: true } } } },
        _count: { select: { timeEntries: true } },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return task;
  }

  async update(id: number, dto: UpdateTaskDto) {
    await this.findOne(id);

    const { startDate, endDate, ...rest } = dto;

    return this.prisma.task.update({
      where: { id },
      data: {
        ...rest,
        status: dto.status as any,
        priority: dto.priority as any,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
      },
      include: {
        zone: true,
        serviceType: true,
        phase: true,
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    await this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Task deleted' };
  }

  async addAssignee(taskId: number, data: { userId: number; role?: string; hourlyRate?: number }) {
    await this.findOne(taskId);

    const existing = await this.prisma.taskAssignee.findFirst({
      where: { taskId, userId: data.userId, deletedAt: null },
    });

    if (existing) {
      throw new ConflictException('User is already assigned to this task');
    }

    return this.prisma.taskAssignee.create({
      data: {
        taskId,
        userId: data.userId,
        role: data.role,
        hourlyRate: data.hourlyRate,
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });
  }

  async removeAssignee(taskId: number, userId: number) {
    const assignee = await this.prisma.taskAssignee.findFirst({
      where: { taskId, userId, deletedAt: null },
    });

    if (!assignee) {
      throw new NotFoundException('Assignee not found');
    }

    await this.prisma.taskAssignee.delete({ where: { id: assignee.id } });
    return { message: 'Assignee removed' };
  }

  async getComments(taskId: number) {
    return this.prisma.taskComment.findMany({
      where: { taskId, parentId: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        replies: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addComment(taskId: number, userId: number, data: { content: string; parentId?: number }) {
    await this.findOne(taskId);

    return this.prisma.taskComment.create({
      data: {
        taskId,
        userId,
        content: data.content,
        parentId: data.parentId,
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });
  }

  async batchReorder(items: { id: number; sortOrder: number; zoneId?: number }[]) {
    await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.task.update({
          where: { id: item.id },
          data: {
            sortOrder: item.sortOrder,
            ...(item.zoneId !== undefined ? { zoneId: item.zoneId } : {}),
          },
        }),
      ),
    );
    return { message: `Reordered ${items.length} tasks` };
  }
}
