import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Checklist items inside a task. Designed per the 2026-06-14 BM mapping
 * meeting:
 *
 *  - NOT separate tasks (no due date, no logged hours, no status workflow)
 *  - Plain text + done/not-done + sortOrder
 *  - Whoever ticks an item gets recorded on doneBy/doneAt so the team
 *    can see who closed each line
 *  - Add/edit/delete is gated upstream on `tasks:write`; toggling done
 *    is gated on `tasks:read` (anyone who can see the task can mark items
 *    as theirs, which matches how teams actually work)
 */
@Injectable()
export class TaskChecklistService {
  constructor(private prisma: PrismaService) {}

  async list(taskId: number) {
    return this.prisma.taskChecklistItem.findMany({
      where: { taskId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        doneByUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async create(taskId: number, userId: number, text: string) {
    // sortOrder = (max existing) + 1 so new items append to the bottom
    const last = await this.prisma.taskChecklistItem.findFirst({
      where: { taskId, deletedAt: null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const sortOrder = (last?.sortOrder ?? -1) + 1;
    return this.prisma.taskChecklistItem.create({
      data: { taskId, text: text.slice(0, 500), createdBy: userId, sortOrder },
      include: {
        doneByUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async update(
    itemId: number,
    userId: number,
    patch: { text?: string; isDone?: boolean },
  ) {
    const item = await this.prisma.taskChecklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Checklist item not found');

    const data: any = {};
    if (patch.text !== undefined) data.text = patch.text.slice(0, 500);
    if (patch.isDone !== undefined && patch.isDone !== item.isDone) {
      data.isDone = patch.isDone;
      // Stamp who closed it (or clear the stamp when re-opening). The
      // doneByUser relation is what the UI renders next to the line.
      data.doneAt = patch.isDone ? new Date() : null;
      data.doneBy = patch.isDone ? userId : null;
    }
    return this.prisma.taskChecklistItem.update({
      where: { id: itemId },
      data,
      include: {
        doneByUser: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        creator: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async remove(itemId: number) {
    const item = await this.prisma.taskChecklistItem.findFirst({
      where: { id: itemId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Checklist item not found');
    await this.prisma.taskChecklistItem.update({
      where: { id: itemId },
      data: { deletedAt: new Date() },
    });
    return { message: 'Checklist item removed' };
  }

  /** Bulk-update sortOrder after a drag-reorder in the UI. */
  async reorder(items: Array<{ id: number; sortOrder: number }>) {
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.taskChecklistItem.update({
          where: { id: it.id },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return { message: 'Reordered' };
  }
}
