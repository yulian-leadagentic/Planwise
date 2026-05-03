import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import { BusinessPartnerRelationshipsService } from '../business-partner-relationships/business-partner-relationships.service';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private bpRelationships: BusinessPartnerRelationshipsService,
  ) {}

  async create(userId: number, dto: CreateProjectDto) {
    const { memberIds, leaderId, ...rest } = dto;

    const project = await this.prisma.project.create({
      data: {
        ...rest,
        leaderId: leaderId && leaderId > 0 ? leaderId : null,
        createdBy: userId,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        projectType: true, department: true, categories: { include: { serviceType: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
        leader: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });

    // Auto-add leader as a member with role "Project Leader"
    if (dto.leaderId) {
      await this.prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: dto.leaderId } },
        create: { projectId: project.id, userId: dto.leaderId, role: 'Project Leader' },
        update: { role: 'Project Leader' },
      });
      try {
        await this.bpRelationships.upsertProjectMemberRelationship({
          userId: dto.leaderId,
          projectId: project.id,
          roleInContext: 'Project Leader',
        });
      } catch { /* best-effort write-through */ }
    }

    // Create ProjectMember records for each member ID
    if (memberIds && memberIds.length > 0) {
      const memberData = memberIds
        .filter((id) => id !== dto.leaderId) // avoid duplicate if leader is also in memberIds
        .map((memberId) => ({ projectId: project.id, userId: memberId }));
      if (memberData.length > 0) {
        await this.prisma.projectMember.createMany({
          data: memberData,
          skipDuplicates: true,
        });
        for (const m of memberData) {
          try {
            await this.bpRelationships.upsertProjectMemberRelationship({
              userId: m.userId,
              projectId: project.id,
              roleInContext: null,
            });
          } catch { /* best-effort */ }
        }
      }
    }

    return project;
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
          projectType: true, department: true, categories: { include: { serviceType: true } },
          creator: { select: { id: true, firstName: true, lastName: true } },
          leader: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
          _count: { select: { members: true, labels: true, tasks: true, zones: true } },
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
        projectType: true, department: true, categories: { include: { serviceType: true } },
        creator: { select: { id: true, firstName: true, lastName: true, email: true } },
        leader: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
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
    const { memberIds, ...rest } = dto;

    const project = await this.prisma.project.update({
      where: { id },
      data: {
        ...rest,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
      include: {
        projectType: true, department: true, categories: { include: { serviceType: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Ensure leader is a member
    if (dto.leaderId && dto.leaderId > 0) {
      await this.prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: id, userId: dto.leaderId } },
        create: { projectId: id, userId: dto.leaderId, role: 'Project Leader' },
        update: { role: 'Project Leader' },
      });
    }

    // Sync team members if provided: add new ones, remove ones no longer in the list
    // (but always keep the leader)
    if (memberIds !== undefined) {
      const existing = await this.prisma.projectMember.findMany({
        where: { projectId: id },
        select: { userId: true, role: true },
      });
      const existingIds = new Set(existing.map((m) => m.userId));
      const desiredIds = new Set(memberIds);
      if (dto.leaderId && dto.leaderId > 0) desiredIds.add(dto.leaderId);

      // Add new members
      const toAdd = [...desiredIds].filter((uid) => !existingIds.has(uid));
      if (toAdd.length > 0) {
        await this.prisma.projectMember.createMany({
          data: toAdd.map((uid) => ({
            projectId: id,
            userId: uid,
            role: uid === dto.leaderId ? 'Project Leader' : null,
          })),
          skipDuplicates: true,
        });
      }

      // Remove members no longer in the list (but never remove the leader)
      const toRemove = [...existingIds].filter(
        (uid) => !desiredIds.has(uid) && uid !== dto.leaderId,
      );
      if (toRemove.length > 0) {
        await this.prisma.projectMember.deleteMany({
          where: { projectId: id, userId: { in: toRemove } },
        });
      }
    }

    return project;
  }

  async remove(id: number) {
    const project = await this.prisma.project.findFirst({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');

    // Delete in order: task assignees → tasks → zones → members → project
    await this.prisma.taskAssignee.deleteMany({ where: { task: { projectId: id } } });
    await this.prisma.taskComment.deleteMany({ where: { task: { projectId: id } } });
    await this.prisma.task.deleteMany({ where: { projectId: id } });
    await this.prisma.zone.deleteMany({ where: { projectId: id } });
    await this.prisma.projectMember.deleteMany({ where: { projectId: id } });
    await this.prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
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

    const member = await this.prisma.projectMember.create({
      data: { projectId, userId, role },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });

    // Mirror to the new Business Partner relationships table.
    // Best-effort — a failure here shouldn't block the legacy write that the
    // rest of the app still reads from.
    try {
      await this.bpRelationships.upsertProjectMemberRelationship({
        userId,
        projectId,
        roleInContext: role ?? null,
      });
    } catch {
      // swallow — see comment above
    }

    return member;
  }

  async getMembers(projectId: number) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, position: true } },
      },
    });
  }

  /**
   * Unified project team view: returns BOTH internal members (login users
   * via project_members) AND external partners (BP relationships pointing
   * at this project with relationship_type != project_member).
   *
   * Each row has a `kind` discriminator the frontend uses to render and
   * dispatch remove actions correctly.
   */
  async getTeam(projectId: number) {
    await this.findOne(projectId);

    const [members, relationships] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              avatarUrl: true,
              position: true,
              businessPartnerId: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.businessPartnerRelationship.findMany({
        where: {
          targetType: 'project',
          targetId: projectId,
          status: 'active',
          relationshipType: { code: { not: 'project_member' } },
        },
        include: {
          source: {
            select: {
              id: true,
              partnerType: true,
              displayName: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              user: { select: { id: true } },
            },
          },
          relationshipType: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const internal = members.map((m) => ({
      kind: 'internal' as const,
      id: m.id,                 // ProjectMember.id (used for remove)
      userId: m.user?.id ?? m.userId,
      businessPartnerId: m.user?.businessPartnerId ?? null,
      displayName: `${m.user?.firstName ?? ''} ${m.user?.lastName ?? ''}`.trim(),
      firstName: m.user?.firstName ?? null,
      lastName: m.user?.lastName ?? null,
      email: m.user?.email ?? null,
      avatarUrl: m.user?.avatarUrl ?? null,
      position: m.user?.position ?? null,
      role: m.role,
      relationshipType: null as null | { id: number; code: string; name: string },
      createdAt: m.createdAt,
    }));

    const external = relationships.map((r) => ({
      kind: 'external' as const,
      id: r.id,                 // BusinessPartnerRelationship.id
      userId: r.source.user?.id ?? null,
      businessPartnerId: r.source.id,
      displayName: r.source.displayName,
      firstName: r.source.firstName,
      lastName: r.source.lastName,
      email: r.source.email,
      avatarUrl: null as string | null,
      position: null as string | null,
      role: r.roleInContext,
      relationshipType: r.relationshipType,
      createdAt: r.createdAt,
    }));

    return [...internal, ...external];
  }

  async removeMember(projectId: number, userId: number) {
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    try {
      await this.bpRelationships.removeProjectMemberRelationship({ userId, projectId });
    } catch {
      // best-effort write-through
    }
    return { message: 'Member removed' };
  }

  async setLeader(projectId: number, userId: number) {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { leaderId: userId },
      include: { leader: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  async addDependency(taskId: number, dependsOnId: number) {
    // Prevent self-dependency
    if (taskId === dependsOnId) throw new BadRequestException('Task cannot depend on itself');
    // Prevent circular (A→B→A)
    const reverse = await this.prisma.taskDependency.findFirst({
      where: { taskId: dependsOnId, dependsOnId: taskId },
    });
    if (reverse) throw new BadRequestException('Circular dependency detected');

    return this.prisma.taskDependency.create({
      data: { taskId, dependsOnId },
      include: { dependsOn: { select: { id: true, code: true, name: true } } },
    });
  }

  async removeDependency(taskId: number, dependsOnId: number) {
    await this.prisma.taskDependency.delete({
      where: { taskId_dependsOnId: { taskId, dependsOnId } },
    });
    return { message: 'Dependency removed' };
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

    // Helper to convert BigInt values to numbers in raw query results
    const serializeRaw = (rows: any[]) =>
      rows.map((row: any) => {
        const obj: any = {};
        for (const [k, v] of Object.entries(row)) {
          obj[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return obj;
      });

    const byZone = serializeRaw(await this.prisma.$queryRaw`
      SELECT z.id, z.name, z.path, z.depth,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount,
        COUNT(t.id) as task_count
      FROM zones z
      LEFT JOIN tasks t ON t.zone_id = z.id AND t.deleted_at IS NULL AND t.is_archived = false
      WHERE z.project_id = ${projectId} AND z.deleted_at IS NULL
      GROUP BY z.id ORDER BY z.path
    `);

    const byServiceType = serializeRaw(await this.prisma.$queryRaw`
      SELECT st.id, st.name, st.code, st.color,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount,
        COUNT(t.id) as task_count
      FROM tasks t
      LEFT JOIN service_types st ON st.id = t.service_type_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
      GROUP BY st.id
    `);

    const byPhase = serializeRaw(await this.prisma.$queryRaw`
      SELECT p.id, p.name,
        COALESCE(SUM(t.budget_hours), 0) as total_hours,
        COALESCE(SUM(t.budget_amount), 0) as total_amount
      FROM tasks t
      LEFT JOIN phases p ON p.id = t.phase_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL AND t.is_archived = false
      GROUP BY p.id
    `);

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
