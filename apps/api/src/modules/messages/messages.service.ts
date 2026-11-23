import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, MessageEntityType, MessageType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { CreateMessageDto } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';
import { MessageAccessService, MessageViewer, ThreadRef, parseEntityType } from './message-access.service';

const authorSelect = {
  id: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
};

const messageInclude = {
  author: { select: authorSelect },
  mentions: {
    include: { user: { select: authorSelect } },
  },
  _count: { select: { replies: true } },
};

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private msgAccess: MessageAccessService,
  ) {}

  /** Loads a live message or throws 404. */
  private async loadMessage(id: number) {
    const message = await this.prisma.message.findFirst({ where: { id, deletedAt: null } });
    if (!message) throw new NotFoundException('Message not found');
    return message;
  }

  /** Creates one notification and pushes it to the bell socket. */
  private async notify(data: Prisma.NotificationUncheckedCreateInput) {
    const notification = await this.prisma.notification.create({ data });
    this.eventEmitter.emit('notification.created', notification);
  }

  async create(viewer: MessageViewer, dto: CreateMessageDto) {
    const userId = viewer.id;

    // Round 4: a new thread needs access to its entity. A reply needs
    // access to the thread (entity access, or a mention in it), and its
    // parent must be in the same discussion.
    let parentId: number | null = null;
    let parentRef: (ThreadRef & { authorId: number | null }) | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.message.findFirst({
        where: { id: dto.parentId, deletedAt: null },
        select: { id: true, parentId: true, entityType: true, entityId: true, authorId: true },
      });
      if (!parent) throw new NotFoundException('The message you are replying to was not found');
      if (parent.entityType !== dto.entityType || parent.entityId !== dto.entityId) {
        throw new BadRequestException('A reply must be posted in the same discussion as the message it answers.');
      }
      await this.msgAccess.assertThreadAccess(viewer, parent);
      // Threads are one level deep: a reply to a reply joins the thread.
      parentId = await this.msgAccess.threadRootId(parent);
      parentRef = parent;
    } else {
      await this.msgAccess.assertEntityAccess(viewer, dto.entityType, dto.entityId);
    }

    // Attachments are stashed inside the metadata JSON column. Reusing
    // metadata avoids a schema migration and keeps the existing UI
    // readers (which spread metadata into a single object) working as
    // long as they don't clobber the attachments key.
    // Prisma's Json typing rejects nested DTO classes — cast through
    // Prisma.JsonObject which it accepts. The shape is plain
    // { attachments: [...] } so JSON serialization is safe.
    const metadata =
      dto.attachments && dto.attachments.length > 0
        ? ({ attachments: dto.attachments.map((a) => ({ ...a })) } as Prisma.JsonObject)
        : undefined;
    const message = await this.prisma.message.create({
      data: {
        entityType: dto.entityType,
        entityId: dto.entityId,
        parentId,
        authorId: userId,
        type: 'user',
        content: dto.content,
        ...(metadata ? { metadata } : {}),
      },
      include: messageInclude,
    });

    // Mentions: anyone active in the company. The mention row is what
    // grants the mentioned user read + reply on this thread.
    if (dto.mentionedUserIds && dto.mentionedUserIds.length > 0) {
      const requested = [...new Set(dto.mentionedUserIds)];
      const active = await this.prisma.user.findMany({
        where: { id: { in: requested }, isActive: true, deletedAt: null },
        select: { id: true },
      });
      const uniqueIds = active.map((u) => u.id);
      if (uniqueIds.length > 0) {
        await this.prisma.messageMention.createMany({
          data: uniqueIds.map((uid) => ({ messageId: message.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      for (const uid of uniqueIds.filter((id) => id !== userId)) {
        await this.notify({
          userId: uid,
          type: 'mention',
          title: 'You were mentioned',
          body: dto.content.substring(0, 200),
          entityType: dto.entityType,
          entityId: dto.entityId,
          actorId: userId,
          messageId: message.id,
        });
      }
    }

    // If it's a reply, notify the author of the message replied to —
    // only while he can still see the thread (the body quotes the reply).
    const parentAuthorId = parentRef?.authorId;
    if (
      parentRef &&
      parentAuthorId &&
      parentAuthorId !== userId &&
      (await this.msgAccess.userCanSeeThread(parentAuthorId, parentRef))
    ) {
      await this.notify({
        userId: parentAuthorId,
        type: 'reply',
        title: 'New reply to your message',
        body: dto.content.substring(0, 200),
        entityType: dto.entityType,
        entityId: dto.entityId,
        actorId: userId,
        messageId: message.id,
      });
    }

    // Re-fetch with mentions included
    const fullMessage = await this.prisma.message.findUnique({
      where: { id: message.id },
      include: {
        ...messageInclude,
        mentions: { include: { user: { select: authorSelect } } },
      },
    });

    // Emit real-time event
    this.eventEmitter.emit('message.created', {
      message: fullMessage,
      entityType: dto.entityType,
      entityId: dto.entityId,
    });

    return fullMessage;
  }

  // ─── Resolved/Unresolved thread management ──────────────────────────────

  /**
   * Round 4 (review fix) — a mention lets a user read and reply in the
   * thread, nothing more: resolving or reopening it needs access to the
   * project (403 NOT_PROJECT_MEMBER for a mention-only viewer).
   */
  private async assertCanResolve(viewer: MessageViewer, message: ThreadRef): Promise<void> {
    const { viaMention } = await this.msgAccess.assertThreadAccess(viewer, message);
    if (viaMention) {
      throw new PermissionDeniedException(
        'You were mentioned in this thread, so you can read and reply to it. Only project members can resolve or reopen it.',
        { module: 'projects', reason: 'NOT_PROJECT_MEMBER' },
      );
    }
  }

  async resolveThread(messageId: number, viewer: MessageViewer) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, parentId: null },
    });
    if (!message) throw new NotFoundException('Thread not found');
    await this.assertCanResolve(viewer, message);

    return this.prisma.message.update({
      where: { id: messageId },
      data: { metadata: { ...(message.metadata as any ?? {}), resolved: true, resolvedBy: viewer.id, resolvedAt: new Date().toISOString() } },
      include: messageInclude,
    });
  }

  async unresolveThread(messageId: number, viewer: MessageViewer) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, parentId: null },
    });
    if (!message) throw new NotFoundException('Thread not found');
    await this.assertCanResolve(viewer, message);

    const meta = { ...(message.metadata as any ?? {}) };
    delete meta.resolved;
    delete meta.resolvedBy;
    delete meta.resolvedAt;

    return this.prisma.message.update({
      where: { id: messageId },
      data: { metadata: meta },
      include: messageInclude,
    });
  }

  // ─── Search across all discussions ──────────────────────────────────────

  async search(query: string, viewer: MessageViewer, options?: { entityType?: string; page?: number; perPage?: number }) {
    const page = options?.page ?? 1;
    const perPage = options?.perPage ?? 20;
    const skip = (page - 1) * perPage;

    // Round 4: only messages in threads the viewer can see.
    const where = await this.msgAccess.scopeWhere(viewer, {
      deletedAt: null,
      content: { contains: query },
      ...(options?.entityType ? { entityType: parseEntityType(options.entityType) } : {}),
    });

    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: {
          ...messageInclude,
          parent: { select: { id: true, content: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
      }),
      this.prisma.message.count({ where }),
    ]);

    return { data, meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) } };
  }

  // ─── Analytics / KPI data ───────────────────────────────────────────────

  async getAnalytics(viewer: MessageViewer, projectId?: number) {
    // Round 4: every figure covers only the threads the viewer can see.
    const where = await this.msgAccess.scopeWhere(viewer, {
      deletedAt: null,
      ...(projectId ? { entityType: 'project', entityId: projectId } : {}),
    });

    const [totalMessages, totalThreads, unresolvedThreads, mentionCount, recentActivity] = await Promise.all([
      this.prisma.message.count({ where }),
      this.prisma.message.count({ where: { AND: [where, { parentId: null }] } }),
      this.prisma.message.count({
        where: {
          AND: [
            where,
            { parentId: null },
            {
              OR: [
                { metadata: { equals: Prisma.DbNull } },
                { metadata: { path: 'resolved', equals: Prisma.AnyNull } },
              ],
            },
          ],
        },
      }),
      this.prisma.messageMention.count({ where: { message: where } }),
      this.prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { author: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);

    // Calculate average response time for threads with replies
    const threadsWithReplies = await this.prisma.message.findMany({
      where: { AND: [where, { parentId: null, replies: { some: { deletedAt: null } } }] },
      select: {
        createdAt: true,
        replies: { select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
      take: 100,
    });

    let avgResponseMinutes = 0;
    if (threadsWithReplies.length > 0) {
      const totalMinutes = threadsWithReplies.reduce((sum, t) => {
        if (t.replies.length > 0) {
          const diff = (new Date(t.replies[0].createdAt).getTime() - new Date(t.createdAt).getTime()) / 60000;
          return sum + Math.max(0, diff);
        }
        return sum;
      }, 0);
      avgResponseMinutes = Math.round(totalMinutes / threadsWithReplies.length);
    }

    // AI-like urgency detection (keyword-based for MVP)
    const urgentKeywords = ['urgent', 'blocker', 'critical', 'ASAP', 'deadline', 'overdue', 'stuck', 'blocked', 'דחוף', 'חסום'];
    const urgentMessages = await this.prisma.message.count({
      where: {
        AND: [where, { OR: urgentKeywords.map((kw) => ({ content: { contains: kw } })) }],
      },
    });

    return {
      totalMessages,
      totalThreads,
      unresolvedThreads,
      mentionCount,
      avgResponseMinutes,
      urgentMessages,
      recentActivity,
    };
  }

  // ─── AI Features (keyword-based MVP) ────────────────────────────────────

  async suggestRecipients(viewer: MessageViewer, entityTypeRaw: string, entityId: number) {
    const entityType = parseEntityType(entityTypeRaw);
    await this.msgAccess.assertEntityAccess(viewer, entityType, entityId);
    // Suggest users who are: members/assignees + recent thread participants
    const participants: number[] = [];

    if (entityType === 'project') {
      const members = await this.prisma.projectMember.findMany({
        where: { projectId: entityId },
        select: { userId: true },
      });
      participants.push(...members.map((m) => m.userId));
    } else if (entityType === 'task') {
      const assignees = await this.prisma.taskAssignee.findMany({
        where: { taskId: entityId, deletedAt: null },
        select: { userId: true },
      });
      participants.push(...assignees.map((a) => a.userId));

      // Also include task creator
      const task = await this.prisma.task.findUnique({
        where: { id: entityId },
        select: { createdBy: true },
      });
      if (task?.createdBy) participants.push(task.createdBy);
    }

    // Add recent message authors in this entity
    const recentAuthors = await this.prisma.message.findMany({
      where: { entityType, entityId, deletedAt: null, authorId: { not: null } },
      select: { authorId: true },
      distinct: ['authorId'],
      take: 10,
    });
    participants.push(...recentAuthors.filter((a) => a.authorId).map((a) => a.authorId!));

    // Deduplicate and fetch user details
    const uniqueIds = [...new Set(participants)];
    if (uniqueIds.length === 0) return [];

    return this.prisma.user.findMany({
      where: { id: { in: uniqueIds }, isActive: true },
      select: { id: true, firstName: true, lastName: true, avatarUrl: true, position: true },
    });
  }

  async summarizeThread(messageId: number, viewer: MessageViewer) {
    const thread = await this.prisma.message.findFirst({
      where: { id: messageId, parentId: null, deletedAt: null },
      include: {
        author: { select: { firstName: true, lastName: true } },
        replies: {
          where: { deletedAt: null },
          include: { author: { select: { firstName: true, lastName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!thread) throw new NotFoundException('Thread not found');
    await this.msgAccess.assertThreadAccess(viewer, thread);

    // Build summary (keyword-based MVP — production would use LLM)
    const allMessages = [thread, ...thread.replies];
    const participants = new Set(
      allMessages.filter((m) => m.author).map((m) => `${m.author!.firstName} ${m.author!.lastName}`),
    );
    const messageCount = allMessages.length;
    const firstDate = thread.createdAt;
    const lastDate = allMessages[allMessages.length - 1].createdAt;

    // Extract key topics (most common non-trivial words)
    const allText = allMessages.map((m) => m.content).join(' ');
    const words = allText.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    const topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);

    // Detect urgency
    const urgentKeywords = ['urgent', 'blocker', 'critical', 'asap', 'deadline', 'דחוף', 'חסום'];
    const isUrgent = urgentKeywords.some((kw) => allText.toLowerCase().includes(kw));

    // Detect sentiment (simple)
    const positiveWords = ['done', 'completed', 'resolved', 'great', 'approved', 'agreed', 'בוצע', 'מאושר'];
    const negativeWords = ['problem', 'issue', 'failed', 'stuck', 'blocked', 'delay', 'בעיה', 'עיכוב'];
    const posScore = positiveWords.filter((w) => allText.toLowerCase().includes(w)).length;
    const negScore = negativeWords.filter((w) => allText.toLowerCase().includes(w)).length;
    const sentiment = posScore > negScore ? 'positive' : negScore > posScore ? 'negative' : 'neutral';

    return {
      threadId: messageId,
      messageCount,
      participants: [...participants],
      participantCount: participants.size,
      startedAt: firstDate,
      lastActivityAt: lastDate,
      topKeywords: topWords,
      isUrgent,
      sentiment,
      isResolved: !!(thread.metadata as any)?.resolved,
      summary: `Discussion with ${participants.size} participant${participants.size !== 1 ? 's' : ''}, ${messageCount} message${messageCount !== 1 ? 's' : ''}. ${isUrgent ? 'Contains urgent items.' : ''} ${topWords.length > 0 ? `Key topics: ${topWords.join(', ')}.` : ''}`,
    };
  }

  /**
   * Single grouped count query for many (entityType, entityId) pairs.
   * Used by the planning grid's task-discussion bubbles so 30 tasks
   * resolve in ONE round-trip instead of 30. Filters to top-level
   * messages only (parentId IS NULL) to match the per-task badge —
   * which shows the conversation count, not the reply count.
   */
  async countByEntities(
    viewer: MessageViewer,
    entityTypeRaw: string,
    entityIds: number[],
  ): Promise<Record<number, number>> {
    if (entityIds.length === 0) return {};
    const entityType = parseEntityType(entityTypeRaw);
    // Round 4: an entity the viewer can't open counts only the threads
    // he is mentioned in (usually 0).
    const where = await this.msgAccess.scopeWhere(viewer, {
      deletedAt: null,
      parentId: null,
      // QA4 A1: badge counts authored (user) messages only —
      // system/activity events live in the same table but must not
      // turn the task-row bubble blue.
      type: MessageType.user,
      entityType,
      entityId: { in: entityIds },
    });
    const rows = await this.prisma.message.groupBy({
      by: ['entityId'],
      where,
      _count: { entityId: true },
    });
    const map: Record<number, number> = {};
    for (const id of entityIds) map[id] = 0;
    for (const r of rows) map[r.entityId] = r._count.entityId;
    return map;
  }

  async findByEntity(dto: QueryMessagesDto, viewer: MessageViewer) {
    let where: Prisma.MessageWhereInput = {
      deletedAt: null,
      parentId: null, // top-level messages only
    };

    const entityType = dto.entityType ? parseEntityType(dto.entityType) : undefined;
    if (entityType) where.entityType = entityType;
    if (dto.entityId) where.entityId = dto.entityId;

    // Round 4: one entity → its threads when the viewer has access,
    // otherwise only the threads he is mentioned in (403 when none).
    // No entity → every thread the viewer can see.
    if (entityType && dto.entityId) {
      try {
        await this.msgAccess.assertEntityAccess(viewer, entityType, dto.entityId);
      } catch (err) {
        if (!(err instanceof ForbiddenException || err instanceof NotFoundException)) throw err;
        const mentioned = await this.msgAccess.mentionedThreadIds(viewer.id);
        const threads = mentioned.length
          ? await this.prisma.message.findMany({
              where: { ...where, id: { in: mentioned } },
              select: { id: true },
            })
          : [];
        if (threads.length === 0) throw err;
        where = { ...where, id: { in: threads.map((t) => t.id) } };
      }
    } else {
      where = await this.msgAccess.scopeWhere(viewer, where);
    }

    // QA4 A1: the thread renderer needs both user + system rows, so
    // `data` is NEVER filtered by type here. `meta.total` however is
    // always the authored-messages count (type=user) so the badge in
    // the discussion sidebar / panel header reflects real activity.
    // Callers can force a stricter data filter by passing `type`
    // explicitly (e.g. an admin export of user messages only).
    const dataWhere: Prisma.MessageWhereInput = dto.type
      ? { AND: [where, { type: dto.type as MessageType }] }
      : where;
    const countWhere: Prisma.MessageWhereInput = { AND: [where, { type: MessageType.user }] };

    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where: dataWhere,
        include: {
          ...messageInclude,
          replies: {
            where: { deletedAt: null },
            include: messageInclude,
            orderBy: { createdAt: 'asc' },
            take: 50,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: dto.skip,
        take: dto.take,
      }),
      this.prisma.message.count({ where: countWhere }),
    ]);

    return {
      data: await this.withCanDelete(viewer, data),
      meta: {
        total,
        page: dto.page ?? 1,
        perPage: dto.perPage ?? 20,
        totalPages: Math.ceil(total / (dto.perPage ?? 20)),
      },
    };
  }

  async findOne(id: number, viewer: MessageViewer) {
    const message = await this.prisma.message.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...messageInclude,
        replies: {
          where: { deletedAt: null },
          include: messageInclude,
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!message) throw new NotFoundException('Message not found');
    await this.msgAccess.assertThreadAccess(viewer, message);
    const [withFlag] = await this.withCanDelete(viewer, [message]);
    return withFlag;
  }

  /**
   * Adds `canDelete` to each message and its replies (author, project
   * leader or Admin — the DELETE rule) so the web shows Delete only
   * where the server accepts it.
   */
  private async withCanDelete<
    T extends { authorId: number | null; entityType: MessageEntityType; entityId: number; replies?: R[] },
    R extends { authorId: number | null; entityType: MessageEntityType; entityId: number },
  >(viewer: MessageViewer, messages: T[]) {
    const all = messages.flatMap((m) => [m, ...(m.replies ?? [])]);
    const canDelete = await this.msgAccess.deletePredicate(viewer, all);
    return messages.map((m) => ({
      ...m,
      canDelete: canDelete(m),
      ...(m.replies ? { replies: m.replies.map((r) => ({ ...r, canDelete: canDelete(r) })) } : {}),
    }));
  }

  async update(id: number, viewer: MessageViewer, content: string) {
    const message = await this.loadMessage(id);
    await this.msgAccess.assertThreadAccess(viewer, message);
    if (message.authorId !== viewer.id) {
      throw new PermissionDeniedException('You can only edit your own messages.', { reason: 'NOT_OWNER' });
    }

    return this.prisma.message.update({
      where: { id },
      data: { content, isEdited: true },
      include: messageInclude,
    });
  }

  /** Round 4: the author, the project leader or an Admin may delete. */
  async remove(id: number, viewer: MessageViewer) {
    const message = await this.loadMessage(id);
    const { projectId } = await this.msgAccess.assertThreadAccess(viewer, message);

    const allowed =
      viewer.isAdmin ||
      message.authorId === viewer.id ||
      (projectId != null && (await this.msgAccess.isProjectLeader(viewer.id, projectId)));
    if (!allowed) {
      throw new PermissionDeniedException(
        'Only the author, the project leader or an administrator can delete this message.',
        { reason: 'NOT_OWNER' },
      );
    }

    await this.prisma.message.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Message deleted' };
  }

  async getInbox(viewer: MessageViewer, page = 1, perPage = 20) {
    const skip = (page - 1) * perPage;
    const userId = viewer.id;

    // Surface a thread (top-level message) when the user is connected to it:
    //   - mentioned in the parent OR any reply
    //   - authored the parent (so a starter sees their own thread)
    //   - replied to the thread
    // Round 4: and only while he can still see it (project access or a
    // mention), so a removed member loses the project's other threads.
    // `canOpenEntity` = he has access to the entity itself; false means
    // he sees the thread only through a mention (the web opens the
    // discussion drawer instead of the project page).
    const { where, canOpen } = await this.msgAccess.scope(viewer, {
      deletedAt: null,
      parentId: null,
      OR: [
        { mentions: { some: { userId } } },
        { authorId: userId },
        { replies: { some: { authorId: userId, deletedAt: null } } },
        { replies: { some: { mentions: { some: { userId } }, deletedAt: null } } },
      ],
    });

    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: {
          ...messageInclude,
          replies: {
            where: { deletedAt: null },
            include: messageInclude,
            orderBy: { createdAt: 'desc' },
            take: 3,
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: perPage,
      }),
      this.prisma.message.count({ where }),
    ]);

    return {
      data: data.map((m) => ({ ...m, canOpenEntity: canOpen(m.entityType, m.entityId) })),
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  async createSystemMessage(
    entityType: MessageEntityType,
    entityId: number,
    content: string,
    metadata?: Record<string, any>,
  ) {
    return this.prisma.message.create({
      data: {
        entityType,
        entityId,
        type: 'system',
        content,
        metadata: metadata ?? Prisma.DbNull,
      },
      include: messageInclude,
    });
  }
}
