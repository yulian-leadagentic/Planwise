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
    return this.prisma.task.create({
      data: {
        labelId: dto.labelId,
        name: dto.name,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        budgetHours: dto.budgetHours,
        budgetAmount: dto.budgetAmount,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        createdBy: userId,
      },
      include: {
        label: { include: { labelType: true } },
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async findAll(query: QueryTasksDto) {
    const where: Prisma.TaskWhereInput = {};

    if (query.labelId) where.labelId = query.labelId;
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.assigneeId) {
      where.assignees = { some: { userId: query.assigneeId } };
    }
    if (query.search) {
      where.name = { contains: query.search };
    }
    if (query.projectId) {
      where.label = { projectId: query.projectId };
    }

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: 'desc' },
        include: {
          label: { select: { id: true, name: true, path: true, labelType: true } },
          assignees: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
            },
          },
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

  async findOne(id: number) {
    const task = await this.prisma.task.findFirst({
      where: { id },
      include: {
        label: { include: { labelType: true, project: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          },
        },
        planTimes: true,
        comments: {
          where: { parentId: null },
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
            children: {
              include: {
                user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
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

    return this.prisma.task.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        label: { include: { labelType: true } },
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
    await this.prisma.task.delete({ where: { id } });
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

  async addPlanTime(taskId: number, data: { roleTitle: string; plannedHours: number }) {
    await this.findOne(taskId);

    return this.prisma.taskPlanTime.create({
      data: {
        taskId,
        roleTitle: data.roleTitle,
        plannedHours: data.plannedHours,
      },
    });
  }

  async removePlanTime(planTimeId: number) {
    await this.prisma.taskPlanTime.delete({ where: { id: planTimeId } });
    return { message: 'Plan time removed' };
  }
}
