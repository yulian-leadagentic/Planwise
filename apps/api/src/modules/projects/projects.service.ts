import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: number, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        ...dto,
        createdBy: userId,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        projectType: true,
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async findAll(query: QueryProjectsDto) {
    const where: Prisma.ProjectWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.projectTypeId) {
      where.projectTypeId = query.projectTypeId;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { number: { contains: query.search } },
      ];
    }

    if (query.isArchived !== undefined) {
      where.isArchived = query.isArchived;
    }

    const [data, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: 'desc' },
        include: {
          projectType: true,
          creator: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { members: true, labels: true } },
        },
      }),
      this.prisma.project.count({ where }),
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
    const project = await this.prisma.project.findFirst({
      where: { id },
      include: {
        projectType: true,
        creator: { select: { id: true, firstName: true, lastName: true, email: true } },
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          },
        },
        labels: {
          where: { parentId: null },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  async update(id: number, dto: UpdateProjectDto) {
    await this.findOne(id);

    return this.prisma.project.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        projectType: true,
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.project.delete({ where: { id } });
    return { message: 'Project deleted' };
  }

  async addMember(projectId: number, userId: number, role?: string) {
    await this.findOne(projectId);

    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });

    if (existing) {
      throw new ConflictException('User is already a member of this project');
    }

    return this.prisma.projectMember.create({
      data: { projectId, userId, role },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });
  }

  async getMembers(projectId: number) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, position: true } },
      },
    });
  }

  async removeMember(projectId: number, userId: number) {
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    return { message: 'Member removed' };
  }

  async getBudgetSummary(projectId: number) {
    const project = await this.prisma.project.findFirstOrThrow({
      where: { id: projectId },
      include: { contracts: { where: { deletedAt: null } } },
    });

    const totals = await this.prisma.task.aggregate({
      where: { projectId, deletedAt: null, isArchived: false },
      _sum: { budgetHours: true, budgetAmount: true },
      _count: true,
    });

    const byZone = await this.prisma.$queryRaw`
      SELECT z.id, z.name, z.path, z.depth,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount,
        COUNT(t.id) as task_count
      FROM zones z
      LEFT JOIN tasks t ON t.zone_id = z.id AND t.deleted_at IS NULL AND t.is_archived = false
      WHERE z.project_id = ${projectId} AND z.deleted_at IS NULL
      GROUP BY z.id ORDER BY z.path
    `;

    const byServiceType = await this.prisma.$queryRaw`
      SELECT st.id, st.name, st.code, st.color,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount,
        COUNT(t.id) as task_count
      FROM tasks t
      LEFT JOIN service_types st ON st.id = t.service_type_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
      GROUP BY st.id
    `;

    const byPhase = await this.prisma.$queryRaw`
      SELECT p.id, p.name,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount
      FROM tasks t
      LEFT JOIN phases p ON p.id = t.phase_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
      GROUP BY p.id
    `;

    const contractTotal = (project.contracts || []).reduce(
      (sum: number, c: any) => sum + Number(c.totalAmount || 0), 0
    );

    return {
      project: { id: project.id, name: project.name, budget: project.budget },
      totals: {
        hours: Number(totals._sum.budgetHours || 0),
        amount: Number(totals._sum.budgetAmount || 0),
        taskCount: totals._count,
      },
      byZone,
      byServiceType,
      byPhase,
      comparison: {
        contractAmount: contractTotal,
        tasksTotal: Number(totals._sum.budgetAmount || 0),
        remaining: contractTotal - Number(totals._sum.budgetAmount || 0),
        remainingPct: contractTotal > 0
          ? Number(((contractTotal - Number(totals._sum.budgetAmount || 0)) / contractTotal * 100).toFixed(1))
          : null,
        status: Number(totals._sum.budgetAmount || 0) > contractTotal ? 'over_budget' : 'within_budget',
      },
    };
  }
}
