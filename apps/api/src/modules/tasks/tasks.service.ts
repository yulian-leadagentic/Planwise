import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { taskCompletionValue } from '../../common/task-completion';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import * as Sentry from '@sentry/node';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private activityLog: ActivityLogService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Notify every ACTIVE assignee of a task — except the actor — that
   * an attachment was added or removed. Best-effort: a notification
   * failure is logged via the service but never breaks the underlying
   * file operation. Used by add/removeAttachment below.
   */
  private async notifyAssigneesAboutAttachment(params: {
    taskId: number;
    actorId: number | null;
    action: 'added' | 'removed';
    fileName: string;
  }): Promise<void> {
    const { taskId, actorId, action, fileName } = params;
    const task = await this.prisma.task.findFirst({
      where: { id: taskId },
      select: { id: true, code: true, name: true, projectId: true },
    });
    if (!task) return;
    const assignees = await this.prisma.taskAssignee.findMany({
      where: { taskId, deletedAt: null, user: { isActive: true } },
      select: { userId: true },
    });
    const actor = actorId
      ? await this.prisma.user.findUnique({
          where: { id: actorId },
          select: { firstName: true, lastName: true },
        })
      : null;
    const actorLabel = actor ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() : 'Someone';
    const taskLabel = task.code ? `${task.code} ${task.name}` : task.name;
    const verb = action === 'added' ? 'attached' : 'removed';
    const title = `${actorLabel} ${verb} "${fileName}" on ${taskLabel}`;
    for (const a of assignees) {
      if (a.userId === actorId) continue; // don't notify the person who did it
      try {
        await this.notifications.create({
          userId: a.userId,
          type: action === 'added' ? 'task.attachment.added' : 'task.attachment.removed',
          title,
          data: { taskId, projectId: task.projectId, fileName },
        });
      } catch (e) {
        Sentry.captureException(e);
        // Best-effort — one failed notification mustn't take down the
        // attach/delete write that already succeeded.
      }
    }
  }

  /**
   * Every CORE task (isPersonal !== true) must carry the fields that
   * make it schedulable and countable: a Service (serviceTypeId), a
   * Zone (zoneId), a Deliverable link (projectDeliverableId OR
   * deliverableTemplateId), and an explicit Review flag
   * (requiresReview must be set, not defaulted). Personal tasks are
   * exempt — they belong to the individual employee.
   *
   * Returns the list of missing field names — an empty list means the
   * task is valid. Callers throw a 400 with a machine-readable body so
   * the frontend can highlight each field inline.
   */
  private missingCoreFields(
    dto: Partial<CreateTaskDto>,
    existing?: { zoneId: number | null; serviceTypeId: number | null; projectDeliverableId: number | null; deliverableTemplateId: number | null; requiresReview: boolean | null; isPersonal: boolean } | null,
  ): string[] {
    const merged = {
      isPersonal: dto.isPersonal ?? existing?.isPersonal ?? false,
      // For each field: prefer the DTO value if the caller sent that key
      // (including explicit null → "clearing"), otherwise fall through to
      // the persisted value on update.
      zoneId: dto.zoneId !== undefined ? dto.zoneId : (existing?.zoneId ?? null),
      serviceTypeId: dto.serviceTypeId !== undefined ? dto.serviceTypeId : (existing?.serviceTypeId ?? null),
      projectDeliverableId:
        dto.projectDeliverableId !== undefined
          ? dto.projectDeliverableId
          : (existing?.projectDeliverableId ?? null),
      deliverableTemplateId:
        dto.deliverableTemplateId !== undefined
          ? dto.deliverableTemplateId
          : (existing?.deliverableTemplateId ?? null),
      // requiresReview must be explicitly set on a core task — on
      // create we detect "not sent"; on update we fall through to the
      // existing value (already a boolean, always set).
      requiresReview:
        dto.requiresReview !== undefined
          ? dto.requiresReview
          : (existing?.requiresReview ?? null),
    };
    if (merged.isPersonal) return [];
    const missing: string[] = [];
    if (merged.serviceTypeId == null) missing.push('serviceTypeId');
    if (merged.zoneId == null) missing.push('zoneId');
    if (merged.projectDeliverableId == null && merged.deliverableTemplateId == null) {
      missing.push('projectDeliverableId');
    }
    if (merged.requiresReview == null) missing.push('requiresReview');
    return missing;
  }

  async create(userId: number, dto: CreateTaskDto) {
    // Three paths:
    //   • personal task: isPersonal=true → project/zone/service ALL optional
    //   • zoned task:    zoneId provided → projectId is inferred from the zone
    //   • root task:     zoneId omitted  → projectId must be in the DTO
    // Personal tasks (Tier D #1) don't require any project context — an
    // employee opens one for themselves. If they happen to link it to a
    // project/deliverable the hours still roll up, but the task doesn't
    // block that Deliverable's completion.
    //
    // Core-task guardrail (Ops backlog #2, 2026-08-08): a non-personal
    // task MUST carry Service, Zone, Deliverable, and an explicit
    // Review flag. Reject with a structured 400 listing every missing
    // field so the frontend can highlight them inline.
    const missing = this.missingCoreFields(dto);
    if (missing.length > 0) {
      throw new BadRequestException({
        error: 'missing_required_fields',
        message: 'Core tasks require Service, Zone, Deliverable, and an explicit Review flag.',
        missing,
      });
    }
    let projectId: number | null = null;
    if (dto.isPersonal) {
      // Any / all of the project context fields may be supplied but none are required.
      projectId = dto.projectId ?? null;
      if (dto.zoneId) {
        const zone = await this.prisma.zone.findFirst({ where: { id: dto.zoneId } });
        if (zone) projectId = zone.projectId;
      }
    } else if (dto.zoneId) {
      const zone = await this.prisma.zone.findFirst({ where: { id: dto.zoneId } });
      if (!zone) {
        throw new NotFoundException('Zone not found');
      }
      projectId = zone.projectId;
    } else {
      if (!dto.projectId) {
        throw new NotFoundException('projectId is required when zoneId is not provided');
      }
      projectId = dto.projectId;
    }

    // If serviceTypeId provided AND we have a zone, upsert the
    // ZoneServiceType junction row. For project-root tasks we skip this
    // since there's no zone to associate with.
    if (dto.serviceTypeId && dto.zoneId) {
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

    // Smart-insert sortOrder — Commit 8 · Model B. Place the new row in
    // its date-driven position among current siblings (container = same
    // project + same zone) without renumbering the neighbours. If no
    // date, append at the tail. See migration
    // 20260830100000_planning_sequence_backfill for the seed rule the
    // sibling column reflects (multiples of 1000 give midpoint headroom).
    const estimatedStartDate = dto.estimatedStartDate ? new Date(dto.estimatedStartDate) : null;
    const sortOrder = await this.computeInsertSortOrder({
      projectId,
      zoneId: dto.zoneId ?? null,
      estimatedStartDate,
    });

    const task = await this.prisma.task.create({
      data: {
        zoneId: dto.zoneId ?? null,
        projectId,
        serviceTypeId: dto.serviceTypeId,
        // Source Deliverable (Template). Optional — null is fine for
        // ad-hoc tasks not tied to a template.
        deliverableTemplateId: dto.deliverableTemplateId ?? null,
        // First-class project-owned Deliverable link (authoritative).
        projectDeliverableId: dto.projectDeliverableId ?? null,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        budgetHours: dto.budgetHours,
        budgetAmount: dto.budgetAmount,
        phaseId: dto.phaseId,
        priority: dto.priority as any,
        // Planning forecast — distinct from `startDate` (actual start).
        estimatedStartDate,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        sortOrder,
        // Personal-task + optional-review flags (Tier D #1 + #2).
        // isPersonal defaults to false at the column level; we still
        // pass it explicitly so the API contract is visible.
        isPersonal: dto.isPersonal ?? false,
        requiresReview: dto.requiresReview ?? true,
        createdBy: userId,
        // Personal tasks are "for yourself" — auto-assign the creator so
        // the task shows up in My Tasks (the /mine query filters by
        // assignee, not by creator). Non-personal tasks keep explicit
        // assignment via addAssignee.
        assignees: dto.isPersonal ? { create: [{ userId }] } : undefined,
      },
      include: {
        zone: true,
        serviceType: true,
        phase: true,
        deliverableTemplate: { select: { id: true, name: true } },
        assignees: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
        },
      },
    });

    await this.activityLog.logTaskCreated({
      actorUserId: userId,
      projectId: task.projectId,
      entityId: task.id,
      taskCode: task.code ?? null,
      taskName: task.name,
    });

    return task;
  }

  async findAll(query: QueryTasksDto, restrictToProjectIds?: number[]) {
    // archived=true flips the visibility predicate from "alive only" to
    // "archived only" — used by the Archived tab on /tasks. The default
    // is alive-only so existing callers don't change.
    const where: Prisma.TaskWhereInput = query.archived
      ? { deletedAt: { not: null } }
      : { deletedAt: null };

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
    // Personal-task filter — client feedback 2026-08-02. Default
    // (undefined / 'include') returns everything so existing callers
    // keep working; reports pass 'exclude' or 'only' to slice by
    // personal-ness without any UI-side filtering.
    if (query.personal === 'exclude') where.isPersonal = false;
    else if (query.personal === 'only') where.isPersonal = true;

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
          deliverableTemplate: { select: { id: true, name: true } },
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
        deliverableTemplate: { select: { id: true, name: true } },
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

    // BIM Leader per project (batched to avoid n+1). Mirrors the
    // findOne logic in projects.service — walks project_partner_roles
    // where role.code = 'bim_leader', prefers the linked User row and
    // falls back to the BP's name fields, then displayName. Attached
    // onto task.project.bimLeader so the Kanban card can render it.
    // (T-fix Tier A #11, 2026-06-30.)
    const projectIds = Array.from(new Set(tasks.map((t) => t.projectId).filter((v): v is number => v != null)));
    const bimLeaderByProject = new Map<number, { firstName: string | null; lastName: string | null } | null>();
    if (projectIds.length > 0) {
      const bimRoleType = await this.prisma.projectRoleType.findUnique({ where: { code: 'bim_leader' } });
      if (bimRoleType) {
        const now = new Date();
        const pprs = await this.prisma.projectPartnerRole.findMany({
          where: {
            projectId: { in: projectIds },
            roleId: bimRoleType.id,
            OR: [{ validTo: { gte: now } as any }, { validTo: undefined as any }],
          },
          include: {
            party: { select: { id: true, displayName: true, firstName: true, lastName: true } },
          },
        });
        const bpIds = pprs.map((p) => p.party?.id).filter((v): v is number => v != null);
        const users = bpIds.length
          ? await this.prisma.user.findMany({
              where: { businessPartnerId: { in: bpIds }, isActive: true },
              select: { businessPartnerId: true, firstName: true, lastName: true },
            })
          : [];
        const userByBp = new Map(users.map((u) => [u.businessPartnerId, u]));
        for (const ppr of pprs) {
          const bp = ppr.party;
          if (!bp) continue;
          const linked = userByBp.get(bp.id);
          if (linked) {
            bimLeaderByProject.set(ppr.projectId, { firstName: linked.firstName, lastName: linked.lastName });
          } else {
            const hasFullName = !!(bp.firstName && bp.lastName);
            bimLeaderByProject.set(ppr.projectId, {
              firstName: hasFullName ? bp.firstName : (bp.firstName ?? bp.displayName),
              lastName: hasFullName ? bp.lastName : (bp.lastName ?? null),
            });
          }
        }
      }
    }

    // `isReady` = "the user should be working on this by now" (client
    // feedback 2026-08-02 item 5). Derived from estimatedStartDate:
    // if the task's forecast start is more than READY_LEAD_DAYS in
    // the future, we tag it as not-yet-ready so the Kanban can hide
    // it from the active board while keeping it in the underlying
    // list. Null estStart → treated as ready (unblocked).
    const READY_LEAD_DAYS = 7;
    const readyThreshold = new Date();
    readyThreshold.setUTCHours(0, 0, 0, 0);
    readyThreshold.setUTCDate(readyThreshold.getUTCDate() + READY_LEAD_DAYS);

    return tasks.map((t) => {
      const agg = timeByTask.get(t.id);
      const zoneIdForLookup = t.zone?.id;
      const zonePath = (zoneIdForLookup != null
        ? zoneById.get(zoneIdForLookup)?.path ?? ''
        : '') as string;
      const zoneBreadcrumb = zonePath
        .split('/')
        .map((s) => Number(s))
        .filter((n) => !Number.isNaN(n))
        .map((id) => zoneNameById.get(id)?.name)
        .filter((n): n is string => !!n);
      const bimLeader = t.projectId != null ? bimLeaderByProject.get(t.projectId) ?? null : null;
      const isReady = t.estimatedStartDate == null
        ? true
        : new Date(t.estimatedStartDate) <= readyThreshold;
      return {
        ...t,
        loggedMinutes: agg?.minutes ?? 0,
        lastActivityDate: agg?.lastDate ?? null,
        zoneBreadcrumb,
        project: t.project ? { ...t.project, bimLeader } : t.project,
        isReady,
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
        deliverableTemplate: { select: { id: true, name: true } },
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

    // Core-task guardrail (Ops backlog #2, 2026-08-08 · refined
    // 2026-08-19 for PR-010/011): the invariant is that a non-personal
    // task must always carry Service, Zone, Deliverable, and an
    // explicit Review flag. But re-running the check on *every* PATCH
    // regressed a common workflow — a legacy task that predates the
    // guardrail (or was created incomplete) could not have its status
    // or dates changed, because a partial update let the missing
    // fields fall through and the check refused to save. Neither the
    // status nor the date field caused the failure; the check would
    // block a `dueDate: '2026-09-01'` PATCH the same as it would
    // block clearing a required column.
    //
    // Gate: only re-validate when the DTO actually touches one of the
    // core fields. `undefined` = key not sent = leave alone; `null` =
    // key sent as null = clearing (still validated). Status-only,
    // date-only, priority-only, assignee, description edits proceed.
    // Editing that clears a required column still 400s (invariant
    // intact). Create-path enforcement in `create()` is unchanged.
    const CORE_FIELD_KEYS = [
      'serviceTypeId',
      'zoneId',
      'projectDeliverableId',
      'deliverableTemplateId',
      'requiresReview',
      'isPersonal',
    ] as const;
    const touchesCoreField = CORE_FIELD_KEYS.some((k) =>
      Object.prototype.hasOwnProperty.call(dto, k),
    );

    if (touchesCoreField) {
      const existingCore = {
        zoneId: (existing as any).zoneId ?? null,
        serviceTypeId: (existing as any).serviceTypeId ?? null,
        projectDeliverableId: (existing as any).projectDeliverableId ?? null,
        deliverableTemplateId: (existing as any).deliverableTemplateId ?? null,
        requiresReview: (existing as any).requiresReview ?? null,
        isPersonal: (existing as any).isPersonal ?? false,
      };
      const missing = this.missingCoreFields(dto, existingCore);
      if (missing.length > 0) {
        throw new BadRequestException({
          error: 'missing_required_fields',
          message: 'Core tasks require Service, Zone, Deliverable, and an explicit Review flag.',
          missing,
        });
      }
    }

    // Pull date fields out so we can either set them, clear them, or leave
    // them untouched depending on whether the caller sent each key.
    // (Empty string / null → null; missing → leave alone.)
    const { startDate, endDate, estimatedStartDate, ...rest } = dto;
    const dateOrNull = (v: string | null | undefined) =>
      v === undefined ? undefined : (v ? new Date(v) : null);

    // Detect manual due-date change so future Deliverable-target
    // propagation doesn't silently clobber the user's edit. If endDate
    // is present in the DTO AND different from the previous value,
    // mark the task as user-overridden. Setting it back to the
    // deliverable's target (or to null) via the API leaves the flag
    // as-is; only the "Force apply target" path clears it.
    // (Tier E #10 revision, 2026-08-02.)
    const shouldMarkOverride =
      endDate !== undefined &&
      dateOrNull(endDate as any)?.getTime() !== (existing as any).endDate?.getTime();

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...rest,
        status: dto.status as any,
        priority: dto.priority as any,
        estimatedStartDate: dateOrNull(estimatedStartDate as any),
        startDate: dateOrNull(startDate as any),
        endDate: dateOrNull(endDate as any),
        ...(shouldMarkOverride ? { dueDateOverridden: true } : {}),
      },
      include: {
        zone: true,
        serviceType: true,
        phase: true,
        deliverableTemplate: { select: { id: true, name: true } },
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

    // Activity log — status change gets its own semantic entry so the
    // Activity tab can show "X status: To Do → In Progress" without
    // having to diff before/after. All other field changes roll up into
    // one generic "updated" line with the changed field list.
    if (dto.status && dto.status !== (existing as any).status) {
      await this.activityLog.logTaskStatusChange({
        actorUserId: userId,
        projectId: (existing as any).projectId,
        entityId: id,
        taskCode: (existing as any).code ?? null,
        taskName: (existing as any).name,
        oldStatus: (existing as any).status,
        newStatus: dto.status,
      });
    }
    const nonStatusKeys = Object.keys(dto).filter((k) => k !== 'status');
    if (nonStatusKeys.length > 0) {
      await this.activityLog.logTaskUpdated({
        actorUserId: userId,
        projectId: (existing as any).projectId,
        entityId: id,
        taskCode: (existing as any).code ?? null,
        taskName: (existing as any).name,
        changedFields: nonStatusKeys,
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

  /**
   * Recompute and persist `completionPct` for one task. Delegates to the
   * canonical helper at `apps/api/src/common/task-completion` so this
   * write path stays lockstep with `time-entries.service#syncTaskCompletion`
   * and every read-time rollup (`execution-planning.service`,
   * `projects.service#findAll`, and the web helpers in
   * `apps/web/src/lib/*`). Time entries are aggregated only when the
   * status needs them — completed/cancelled/in_review skip the DB.
   */
  private async recomputeCompletionPct(taskId: number) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { budgetHours: true, status: true },
    });
    if (!task) return;

    let pct: number;
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'in_review') {
      pct = taskCompletionValue({ status: task.status, budgetHours: task.budgetHours });
    } else if (!task.budgetHours || Number(task.budgetHours) === 0) {
      pct = 0;
    } else {
      const agg = await this.prisma.timeEntry.aggregate({
        where: { taskId, deletedAt: null },
        _sum: { minutes: true },
      });
      pct = taskCompletionValue({
        status: task.status,
        budgetHours: task.budgetHours,
        loggedMinutes: agg._sum.minutes ?? 0,
      });
    }

    await this.prisma.task.update({ where: { id: taskId }, data: { completionPct: pct } });
  }

  async remove(id: number) {
    await this.findOne(id);

    // Soft-delete AND flip status to 'cancelled' so any report or
    // rollup that reads status (not just deletedAt) reflects the
    // deletion. Restore() puts the status back to not_started.
    await this.prisma.task.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'cancelled' },
    });

    return { message: 'Task deleted' };
  }

  /**
   * Restore a soft-deleted task — clears deletedAt so the task reappears
   * in normal lists. The /tasks Archived tab uses this. Throws 404 if
   * the task isn't soft-deleted (preventing accidental no-ops).
   */
  async restore(id: number) {
    // IMPORTANT: a global soft-delete middleware rewrites findUnique →
    // findFirst and injects `deletedAt: null` whenever the caller
    // doesn't specify deletedAt. That means a plain findUnique can NEVER
    // see a soft-deleted row — which is exactly the task we're trying to
    // restore. So we query findFirst with an EXPLICIT
    // `deletedAt: { not: null }` predicate; because deletedAt is no
    // longer `undefined`, the middleware leaves it alone and we can
    // actually locate the archived task. (This was the TASK-CREATE-404
    // "Task not found" on restore.)
    const existing = await this.prisma.task.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { id: true },
    });
    if (!existing) {
      // Either the id doesn't exist at all, or it's already active.
      // Distinguish so the caller gets a useful message.
      const live = await this.prisma.task.findFirst({ where: { id }, select: { id: true } });
      if (live) return { message: 'Task is not archived', alreadyActive: true };
      throw new NotFoundException('Task not found');
    }
    // `update` is not touched by the soft-delete middleware, so clearing
    // deletedAt here works directly. Reset status from 'cancelled' (set
    // on delete) back to not_started so the restored task isn't stuck
    // looking cancelled.
    await this.prisma.task.update({
      where: { id },
      data: { deletedAt: null, status: 'not_started' },
    });
    return { message: 'Task restored', id };
  }

  async addAssignee(taskId: number, data: { userId: number; role?: string; hourlyRate?: number }, actorId?: number) {
    await this.findOne(taskId);

    // Defensive: never assign to an inactive (deactivated) user. The UI
    // already filters them out of the picker (since 2026-06-21), but a
    // stale page, a scripted call, or an out-of-band request could still
    // try. Block here with a clear 400 so we fail loud instead of
    // silently writing a row pointing at someone who no longer works
    // with the company.
    const target = await this.prisma.user.findFirst({
      where: { id: data.userId },
      select: { id: true, isActive: true, firstName: true, lastName: true },
    });
    if (!target) {
      throw new NotFoundException(`User ${data.userId} not found`);
    }
    if (!target.isActive) {
      const name = `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim() || `id=${target.id}`;
      throw new BadRequestException(
        `Cannot assign task to inactive user (${name}). Reactivate the user first.`,
      );
    }

    // Check if already actively assigned
    const active = await this.prisma.taskAssignee.findFirst({
      where: { taskId, userId: data.userId, deletedAt: null },
    });
    if (active) {
      throw new ConflictException('User is already assigned to this task');
    }

    // Policy reversal (2026-06-18, per user): no overlap check at the
    // task-ASSIGNMENT stage. Assignment is about who is responsible for
    // the work; it isn't a scheduling claim. Distributing a person
    // across several tasks whose date ranges happen to touch is a
    // legitimate, common operation (planning headcount, code-review
    // duty, supervision, etc.) — blocking it created spurious 409s.
    //
    // The time-entry overlap (different code path, in
    // time-entries.service.ts) STAYS — that one prevents double-booking
    // actual logged hours, which is a real correctness invariant.

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

    // Activity log — needs the parent task's project for the per-project
    // feed. findOne above didn't return it; cheaper to read from result
    // (no relation loaded) or re-fetch the minimal column.
    const taskRow = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, code: true, name: true },
    });
    if (taskRow) {
      const assigneeName = `${result.user?.firstName ?? ''} ${result.user?.lastName ?? ''}`.trim() || `user #${data.userId}`;
      await this.activityLog.logAssigneeAdded({
        actorUserId: actorId,
        projectId: taskRow.projectId,
        entityId: taskId,
        taskCode: taskRow.code ?? null,
        taskName: taskRow.name,
        assigneeName,
      });
    }

    return result;
  }

  async removeAssignee(taskId: number, userId: number, actorId?: number) {
    // Capture context BEFORE delete so the activity log entry has the
    // assignee's name and the parent task's project.
    const [taskRow, assignee] = await Promise.all([
      this.prisma.task.findUnique({
        where: { id: taskId },
        select: { projectId: true, code: true, name: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      }),
    ]);
    await this.prisma.taskAssignee.deleteMany({
      where: { taskId, userId },
    });
    if (taskRow) {
      const assigneeName = `${assignee?.firstName ?? ''} ${assignee?.lastName ?? ''}`.trim() || `user #${userId}`;
      await this.activityLog.logAssigneeRemoved({
        actorUserId: actorId,
        projectId: taskRow.projectId,
        entityId: taskId,
        taskCode: taskRow.code ?? null,
        taskName: taskRow.name,
        assigneeName,
      });
    }
    return { message: 'Assignee removed' };
  }

  async getComments(taskId: number) {
    const attachmentInclude = {
      uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
    };
    return this.prisma.taskComment.findMany({
      where: { taskId, parentId: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        // Per-comment attachments (commentId IS NOT NULL on TaskAttachment).
        // Task-level attachments (commentId IS NULL) stay on the task's own
        // Files section, not here — so the Discussion shows only chips
        // that the comment author actually attached to their message.
        attachments: { include: attachmentInclude, orderBy: { createdAt: 'asc' } },
        replies: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
            attachments: { include: attachmentInclude, orderBy: { createdAt: 'asc' } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addComment(
    taskId: number,
    userId: number,
    data: { content: string; parentId?: number; attachmentIds?: number[] },
  ) {
    await this.findOne(taskId);

    // Create the comment first, then promote any pre-uploaded task-level
    // attachments to belong to it. The frontend flow is:
    //   1. user picks files in the composer
    //   2. /files/upload → urls
    //   3. POST /tasks/:id/attachments per file → ids (task-level so far)
    //   4. POST /tasks/:id/comments with { content, attachmentIds }
    //   5. server sets commentId on those rows so they render with the
    //      comment instead of in the standalone Files section
    const comment = await this.prisma.taskComment.create({
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

    if (data.attachmentIds && data.attachmentIds.length > 0) {
      await this.prisma.taskAttachment.updateMany({
        where: {
          id: { in: data.attachmentIds },
          taskId,
          commentId: null,
          uploadedBy: userId,
        },
        data: { commentId: comment.id },
      });
    }

    // Re-read with attachments so the client gets the full payload back.
    return this.prisma.taskComment.findUnique({
      where: { id: comment.id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        attachments: {
          include: {
            uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * Compute a `sort_order` for a to-be-created task so it lands in
   * date-driven position among current siblings, without renumbering
   * neighbours (Commit 8 · Model B). Container = (projectId, zoneId).
   *
   * Sibling `sort_order` values are seeded as multiples of 1000 by the
   * planning_sequence_backfill migration and by this helper's tail-
   * append branch, so a midpoint (avg of neighbours) has ~500 units of
   * headroom before it would collide.
   *
   * Rules:
   *   • No date → append at tail (`max + 1000`).
   *   • Container empty → 1000.
   *   • Date given, find first sibling whose date > D (siblings sorted
   *     by `sort_order ASC`). Midpoint with the neighbour before, or
   *     head-insert if position 0. All-earlier → tail.
   *   • Undated siblings sort as "later than any date" (nulls-last),
   *     matching the migration's ORDER BY.
   */
  private async computeInsertSortOrder(params: {
    projectId: number | null;
    zoneId: number | null;
    estimatedStartDate: Date | null;
  }): Promise<number> {
    const { projectId, zoneId, estimatedStartDate } = params;
    if (projectId == null) return 1000; // isPersonal, no project — sensible default
    const siblings = await this.prisma.task.findMany({
      where: { projectId, zoneId, deletedAt: null },
      select: { id: true, sortOrder: true, estimatedStartDate: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    if (siblings.length === 0) return 1000;
    const tailAppend = () => (siblings[siblings.length - 1].sortOrder ?? 0) + 1000;
    if (!estimatedStartDate) return tailAppend();
    const newMs = estimatedStartDate.getTime();
    // Find insert position — first sibling whose date > D. Undated siblings
    // count as "later" (nulls-last), same as migration's ORDER BY.
    const insertAt = siblings.findIndex((s) => {
      if (!s.estimatedStartDate) return true;
      return s.estimatedStartDate.getTime() > newMs;
    });
    if (insertAt === -1) return tailAppend();
    const nextSo = siblings[insertAt].sortOrder ?? 0;
    if (insertAt === 0) {
      // Head-insert. Halve the leading gap; fall back to next - 1000 if it
      // would collide with 0.
      return nextSo > 1000 ? Math.floor(nextSo / 2) : Math.max(1, nextSo - 1);
    }
    const prevSo = siblings[insertAt - 1].sortOrder ?? 0;
    const mid = Math.floor((prevSo + nextSo) / 2);
    // Collision guard: if the neighbours are already touching (post-drag
    // sequences can compress) drop to prev + 1 — a subsequent drag will
    // re-space via the reorder endpoint's 1000-step renumber.
    return mid > prevSo && mid < nextSo ? mid : prevSo + 1;
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
    // Only task-level attachments — comment-level ones (commentId IS NOT NULL)
    // show up under their parent comment in the Discussion, not in the
    // task's Files section.
    return this.prisma.taskAttachment.findMany({
      where: { taskId, commentId: null },
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

    const attachment = await this.prisma.taskAttachment.create({
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

    // Notify every other assignee on the task. Awaited so a slow
    // notification path can't cause stale UI on the client, but wrapped
    // in best-effort error handling internally.
    await this.notifyAssigneesAboutAttachment({
      taskId,
      actorId: userId,
      action: 'added',
      fileName: data.fileName,
    });

    return attachment;
  }

  async removeAttachment(attachmentId: number, actorId?: number) {
    // Capture context BEFORE delete so the notification has the file
    // name and the parent task id (the row is gone afterwards).
    const att = await this.prisma.taskAttachment.findUnique({
      where: { id: attachmentId },
      select: { taskId: true, fileName: true },
    });
    await this.prisma.taskAttachment.delete({ where: { id: attachmentId } });
    if (att) {
      await this.notifyAssigneesAboutAttachment({
        taskId: att.taskId,
        actorId: actorId ?? null,
        action: 'removed',
        fileName: att.fileName,
      });
    }
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

  // ─── Review workflow (Tier D #2 + #2a, 2026-06-30) ────────────────
  // Atomic write: bump the task's status AND append a review-event
  // row so the analytics feed always has the full trail. Only three
  // actions are supported to keep the state machine tiny.
  async recordReview(
    taskId: number,
    actorId: number,
    action: 'submit' | 'approve' | 'return',
    reason?: string,
  ) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, status: true, requiresReview: true },
    });
    if (!task) throw new NotFoundException('Task not found');

    // Map action → target status. "Approve" also honors the review
    // flag: if a task didn't need review, its normal path is
    // in_progress → completed; but approve from in_review always
    // lands on completed either way.
    //
    // Return (Ops backlog #6, 2026-08-08) is now allowed from BOTH
    // in_review AND completed — a manager can bounce a finished task
    // back after the fact. Target status is derived from the CURRENT
    // status so the task lands on its previous stage:
    //   • from in_review  → in_progress            (existing)
    //   • from completed  → in_review if requiresReview else in_progress
    //     (previous stage — a task with review always came from
    //     in_review before being approved; skip-review tasks came
    //     from in_progress). Consulting the review-event log for a
    //     more precise "prior stage" is possible but overkill —
    //     the requiresReview flag is authoritative for the workflow
    //     shape.
    let nextStatus: string;
    switch (action) {
      case 'submit':
        if (task.status === 'completed' || task.status === 'cancelled') {
          throw new BadRequestException('Cannot submit a closed task for review');
        }
        nextStatus = 'in_review';
        break;
      case 'approve':
        nextStatus = 'completed';
        break;
      case 'return':
        if (!reason || !reason.trim()) {
          throw new BadRequestException('A reason is required when returning a task');
        }
        if (task.status === 'in_review') {
          nextStatus = 'in_progress';
        } else if (task.status === 'completed') {
          nextStatus = task.requiresReview ? 'in_review' : 'in_progress';
        } else {
          throw new BadRequestException('A task can only be returned from In Review or Done');
        }
        break;
      default:
        throw new BadRequestException('Unknown review action');
    }

    const [_event, updated] = await this.prisma.$transaction([
      this.prisma.taskReviewEvent.create({
        data: {
          taskId,
          actorId,
          action,
          reason: reason?.trim() || null,
        },
      }),
      this.prisma.task.update({
        where: { id: taskId },
        data: { status: nextStatus as any },
        select: { id: true, status: true, requiresReview: true },
      }),
    ]);

    return { task: updated, action, reason: reason?.trim() || null };
  }

  async listReviews(taskId: number) {
    return this.prisma.taskReviewEvent.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: {
        actor: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });
  }

  // Aggregated review stats. Returns a compact JSON the dashboard can
  // slice: per-actor totals + rework rate (return count / submitted
  // count). Kept SQL-free for portability across dev/staging.
  async reviewSummary() {
    const events = await this.prisma.taskReviewEvent.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        actor: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    type ActorStat = {
      actorId: number;
      actorName: string;
      submitted: number;
      approved: number;
      returned: number;
      lastActivityAt: string | null;
    };
    const byActor = new Map<number, ActorStat>();
    let totalSubmitted = 0;
    let totalApproved = 0;
    let totalReturned = 0;
    for (const e of events) {
      const name = `${e.actor?.firstName ?? ''} ${e.actor?.lastName ?? ''}`.trim() || `User #${e.actorId}`;
      if (!byActor.has(e.actorId)) {
        byActor.set(e.actorId, {
          actorId: e.actorId,
          actorName: name,
          submitted: 0,
          approved: 0,
          returned: 0,
          lastActivityAt: null,
        });
      }
      const rec = byActor.get(e.actorId)!;
      rec.lastActivityAt = e.createdAt.toISOString();
      if (e.action === 'submit') { rec.submitted++; totalSubmitted++; }
      else if (e.action === 'approve') { rec.approved++; totalApproved++; }
      else if (e.action === 'return') { rec.returned++; totalReturned++; }
    }

    const totalHandled = totalApproved + totalReturned;
    return {
      totals: {
        submitted: totalSubmitted,
        approved: totalApproved,
        returned: totalReturned,
        reworkRate: totalHandled > 0 ? Math.round((totalReturned / totalHandled) * 100) : 0,
      },
      byActor: Array.from(byActor.values()).sort((a, b) => b.returned - a.returned || b.approved - a.approved),
    };
  }
}
