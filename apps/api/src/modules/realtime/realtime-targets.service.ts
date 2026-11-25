import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { positiveInt } from './realtime.events';

/** The project (and task) a write touched. `taskId` only for task-level writes. */
export interface RealtimeTarget {
  projectId: number;
  taskId?: number;
}

/** A bulk save never names more ids than this (reorder lists, target batches). */
const MAX_BULK_IDS = 1000;

/**
 * Id → project lookups for the realtime interceptor and the domain-event
 * bridge. Every lookup is by primary key, selects only the ids, and
 * returns null (never throws) when the row is gone or is a personal task
 * (no project, so no project room to tell).
 */
@Injectable()
export class RealtimeTargetsService {
  constructor(private readonly prisma: PrismaService) {}

  async task(taskId: number): Promise<RealtimeTarget | null> {
    // Live task first (the soft-delete middleware adds `deletedAt: null`),
    // then an archived one (a write may hit a task archived meanwhile).
    const row =
      (await this.prisma.task.findFirst({ where: { id: taskId }, select: { projectId: true } })) ??
      (await this.prisma.task.findFirst({
        where: { id: taskId, deletedAt: { not: null } },
        select: { projectId: true },
      }));
    const projectId = positiveInt(row?.projectId);
    return projectId == null ? null : { projectId, taskId };
  }

  async checklistItem(itemId: number): Promise<RealtimeTarget | null> {
    const row = await this.prisma.taskChecklistItem.findUnique({
      where: { id: itemId },
      select: { taskId: true },
    });
    return row ? this.task(row.taskId) : null;
  }

  async attachment(attachmentId: number): Promise<RealtimeTarget | null> {
    const row = await this.prisma.taskAttachment.findUnique({
      where: { id: attachmentId },
      select: { taskId: true },
    });
    return row ? this.task(row.taskId) : null;
  }

  async zone(zoneId: number): Promise<RealtimeTarget | null> {
    const row = await this.prisma.zone.findUnique({ where: { id: zoneId }, select: { projectId: true } });
    const projectId = positiveInt(row?.projectId);
    return projectId == null ? null : { projectId };
  }

  async deliverable(deliverableId: number): Promise<RealtimeTarget | null> {
    const row = await this.prisma.projectDeliverable.findUnique({
      where: { id: deliverableId },
      select: { projectId: true },
    });
    const projectId = positiveInt(row?.projectId);
    return projectId == null ? null : { projectId };
  }

  /** Distinct projects of a bulk save's task / zone / deliverable ids. */
  async projectsOf(entity: 'task' | 'zone' | 'deliverable', ids: number[]): Promise<RealtimeTarget[]> {
    const unique = [...new Set(ids)].slice(0, MAX_BULK_IDS);
    if (unique.length === 0) return [];
    const where = { id: { in: unique } };
    const select = { projectId: true } as const;
    let rows: Array<{ projectId: number | null }>;
    if (entity === 'task') rows = await this.prisma.task.findMany({ where, select, distinct: ['projectId'] });
    else if (entity === 'zone') rows = await this.prisma.zone.findMany({ where, select, distinct: ['projectId'] });
    else rows = await this.prisma.projectDeliverable.findMany({ where, select, distinct: ['projectId'] });
    const projectIds = new Set<number>();
    for (const r of rows) {
      const id = positiveInt(r.projectId);
      if (id != null) projectIds.add(id);
    }
    return [...projectIds].map((projectId) => ({ projectId }));
  }
}
