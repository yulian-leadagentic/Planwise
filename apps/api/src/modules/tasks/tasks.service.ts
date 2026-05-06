import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

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
        // Planning forecast — distinct from `startDate` (actual start).
        estimatedStartDate: dto.estimatedStartDate ? new Date(dto.estimatedStartDate) : null,
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

  async findAll(query: QueryTasksDto, restrictToProjectIds?: number[]) {
    const where: Prisma.TaskWhereInput = {
      deletedAt: null,
    };

    if (query.projectId) where.projectId = query.projectId;
    else if (restrictToProjectIds && restrictToProjectIds.length > 0) {
      where.projectId = { in: restrictToProjectIds };
    }
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
    const tasks = await this.prisma.task.findMany({
      where: {
        deletedAt: null,
        isArchived: false,
        assignees: { some: { userId, deletedAt: null } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        zone: { select: { id: true, name: true, zoneType: true } },
        project: { select: { id: true, name: true, number: true } },
        serviceType: { select: { id: true, name: true, code: true, color: true } },
        phase: { select: { id: true, name: true, color: true } },
        assignees: {
          where: { deletedAt: null },
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
      },
    });

    if (tasks.length === 0) return tasks;

    const taskIds = tasks.map((t) => t.id);
    // findMine is the personal Kanban — show ONLY THIS USER'S logged hours
    // per task, not the team total. (The team-total view lives elsewhere,
    // e.g. on the project planning grid.)
    const timeAgg = await this.prisma.timeEntry.groupBy({
      by: ['taskId'],
      where: { taskId: { in: taskIds }, userId, deletedAt: null },
      _sum: { minutes: true },
      _max: { date: true },
    });
    const timeByTask = new Map<number, { minutes: number; lastDate: Date | null }>();
    for (const row of timeAgg) {
      if (row.taskId != null) {
        timeByTask.set(row.taskId, { minutes: row._sum.minutes ?? 0, lastDate: row._max.date ?? null });
      }
    }

    // Zone breadcrumb: walk each task's zone.path ("17/42/108") into a list
    // of zone names so the card can show "Building > Floor 1 > Unit A".
    // We pull every referenced zone in one query, build an id→name map, then
    // split each task's path. The leaf is included.
    const zoneIdSet = new Set<number>();
    const zoneById = new Map<number, any>();
    for (const t of tasks) {
      if (t.zone?.id) zoneById.set(t.zone.id, t.zone);
    }
    // Need .path on every task's zone to walk ancestors. The findMany above
    // selected only id/name/zoneType — refetch the path for these ids.
    if (zoneById.size > 0) {
      const fullZones = await this.prisma.zone.findMany({
        where: { id: { in: Array.from(zoneById.keys()) } },
        select: { id: true, path: true },
      });
      for (const z of fullZones) {
        for (const seg of (z.path ?? '').split('/').filter(Boolean)) {
          const n = Number(seg);
          if (!Number.isNaN(n)) zoneIdSet.add(n);
        }
      }
    }
    const zoneNameById = new Map<number, { name: string; zoneType: string }>();
    if (zoneIdSet.size > 0) {
      const allReferenced = await this.prisma.zone.findMany({
        where: { id: { in: Array.from(zoneIdSet) } },
        select: { id: true, name: true, zoneType: true, path: true },
      });
      for (const z of allReferenced) {
        zoneNameById.set(z.id, { name: z.name, zoneType: z.zoneType });
        // Stash path back into the per-task zone map for the next pass.
        if (zoneById.has(z.id)) {
          zoneById.set(z.id, { ...zoneById.get(z.id), path: z.path });
        }
      }
    }

    return tasks.map((t) => {
      const agg = timeByTask.get(t.id);
      const zonePath = (zoneById.get(t.zone?.id)?.path ?? '') as string;
      const zoneBreadcrumb = zonePath
        .split('/')
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n))
        .map((id) => zoneNameById.get(id)?.name)
        .filter((n): n is string => !!n);
      return {
        ...t,
        loggedMinutes: agg?.minutes ?? 0,
        lastActivityDate: agg?.lastDate ?? null,
        zoneBreadcrumb,
      };
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
          where: { deletedAt: null },
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

    // Aggregate logged time + last activity date for health calculations
    const timeAgg = await this.prisma.timeEntry.aggregate({
      where: { taskId: id, deletedAt: null },
      _sum: { minutes: true },
      _max: { date: true },
    });

    return {
      ...task,
      loggedMinutes: timeAgg._sum.minutes ?? 0,
      lastActivityDate: timeAgg._max.date ?? null,
    };
  }

  async update(id: number, dto: UpdateTaskDto, userId?: number) {
    const existing = await this.findOne(id);

    // Pull date fields out so we can either set them, clear them, or leave
    // them untouched depending on whether the caller sent each key.
    // (Empty string / null → null; missing → leave alone.)
    const { startDate, endDate, estimatedStartDate, ...rest } = dto;
    const dateOrNull = (v: string | null | undefined) =>
      v === undefined ? undefined : (v ? new Date(v) : null);

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...rest,
        status: dto.status as any,
        priority: dto.priority as any,
        estimatedStartDate: dateOrNull(estimatedStartDate as any),
        startDate: dateOrNull(startDate as any),
        endDate: dateOrNull(endDate as any),
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

    // Emit status change event
    if (dto.status && dto.status !== (existing as any).status && userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      });
      this.eventEmitter.emit('task.status.changed', {
        taskId: id,
        projectId: (existing as any).projectId,
        userId,
        oldStatus: (existing as any).status,
        newStatus: dto.status,
        userName: user ? `${user.firstName} ${user.lastName}` : 'System',
      });
    }

    // Re-sync completionPct whenever status changes. The completion model
    // uses status as a ceiling (Done=100, In Review=90, otherwise time-
    // based capped at 80), so a status flip needs to update the persisted
    // value even when no time entry was logged. This mirrors the formula
    // in time-entries.service.ts → syncTaskCompletion and the client-side
    // calculation in apps/web/src/lib/task-health.ts.
    if (dto.status && dto.status !== (existing as any).status) {
      await this.recomputeCompletionPct(id);
    }

    return updated;
  }

  /** Recompute and persist `completionPct` for one task. */
  private async recomputeCompletionPct(taskId: number) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { budgetHours: true, status: true },
    });
    if (!task) return;

    let pct: number;
    if (task.status === 'completed' || task.status === 'cancelled') {
      pct = 100;
    } else if (task.status === 'in_review') {
      pct = 90;
    } else if (!task.budgetHours || Number(task.budgetHours) === 0) {
      pct = 0;
    } else {
      const agg = await this.prisma.timeEntry.aggregate({
        where: { taskId, deletedAt: null },
        _sum: { minutes: true },
      });
      const loggedHours = (agg._sum.minutes ?? 0) / 60;
      pct = Math.min(80, Math.round((loggedHours / Number(task.budgetHours)) * 80));
    }

    await this.prisma.task.update({ where: { id: taskId }, data: { completionPct: pct } });
  }

  async remove(id: number) {
    await this.findOne(id);

    await this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Task deleted' };
  }

  async addAssignee(taskId: number, data: { userId: number; role?: string; hourlyRate?: number }, actorId?: number) {
    await this.findOne(taskId);

    // Check if already actively assigned
    const active = await this.prisma.taskAssignee.findFirst({
      where: { taskId, userId: data.userId, deletedAt: null },
    });
    if (active) {
      throw new ConflictException('User is already assigned to this task');
    }

    // Atomic upsert — handles soft-deleted rows and unique constraints
    const result = await this.prisma.taskAssignee.upsert({
      where: { taskId_userId: { taskId, userId: data.userId } },
      create: { taskId, userId: data.userId, role: data.role, hourlyRate: data.hourlyRate },
      update: { deletedAt: null, role: data.role ?? null, hourlyRate: data.hourlyRate ?? null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true } },
      },
    });

    // Emit assignment event
    if (actorId) {
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      });
      this.eventEmitter.emit('task.assignee.added', {
        taskId,
        userId: actorId,
        assigneeId: data.userId,
        userName: actor ? `${actor.firstName} ${actor.lastName}` : 'System',
        assigneeName: result.user ? `${result.user.firstName} ${result.user.lastName}` : 'User',
      });
    }

    return result;
  }

  async removeAssignee(taskId: number, userId: number) {
    await this.prisma.taskAssignee.deleteMany({
      where: { taskId, userId },
    });
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

  // ─── Attachments ────────────────────────────────────────────────────────

  async getAttachments(taskId: number) {
    return this.prisma.taskAttachment.findMany({
      where: { taskId },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addAttachment(taskId: number, userId: number, data: { fileName: string; fileUrl: string; fileSize?: number; mimeType?: string }) {
    await this.findOne(taskId);

    // Only accept relative URLs returned by our own uploader — prevents stored
    // XSS / open-redirect via attacker-controlled javascript:/http:// URLs.
    // Reject protocol-relative (//host/x) URLs too — they inherit the page's
    // scheme and would redirect users to an attacker-controlled domain.
    if (
      typeof data.fileUrl !== 'string' ||
      !data.fileUrl.startsWith('/') ||
      data.fileUrl.startsWith('//') ||
      data.fileUrl.includes('://')
    ) {
      throw new BadRequestException('fileUrl must be a relative path returned by /files/upload');
    }

    return this.prisma.taskAttachment.create({
      data: {
        taskId,
        fileName: data.fileName,
        fileUrl: data.fileUrl,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        uploadedBy: userId,
      },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async removeAttachment(attachmentId: number) {
    await this.prisma.taskAttachment.delete({ where: { id: attachmentId } });
    return { message: 'Attachment removed' };
  }

  /**
   * Resolves an attachment → its task ID then runs the supplied access check.
   * Throws NotFoundException if the attachment does not exist.
   */
  async assertAttachmentAccess(
    attachmentId: number,
    check: (taskId: number) => Promise<void>,
  ): Promise<void> {
    const att = await this.prisma.taskAttachment.findUnique({
      where: { id: attachmentId },
      select: { taskId: true },
    });
    if (!att) throw new NotFoundException('Attachment not found');
    await check(att.taskId);
  }
}
