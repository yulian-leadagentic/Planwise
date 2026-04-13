import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, MessageEntityType } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';

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
  ) {}

  async create(userId: number, dto: CreateMessageDto) {
    const message = await this.prisma.message.create({
      data: {
        entityType: dto.entityType,
        entityId: dto.entityId,
        parentId: dto.parentId || null,
        authorId: userId,
        type: 'user',
        content: dto.content,
      },
      include: messageInclude,
    });

    // Create mentions
    if (dto.mentionedUserIds && dto.mentionedUserIds.length > 0) {
      const uniqueIds = [...new Set(dto.mentionedUserIds)];
      await this.prisma.messageMention.createMany({
        data: uniqueIds.map((uid) => ({ messageId: message.id, userId: uid })),
        skipDuplicates: true,
      });

      // Create notifications for mentioned users
      await this.prisma.notification.createMany({
        data: uniqueIds
          .filter((uid) => uid !== userId)
          .map((uid) => ({
            userId: uid,
            type: 'mention',
            title: 'You were mentioned',
            body: dto.content.substring(0, 200),
            entityType: dto.entityType,
            entityId: dto.entityId,
            actorId: userId,
            messageId: message.id,
          })),
      });
    }

    // If it's a reply, notify the parent author
    if (dto.parentId) {
      const parent = await this.prisma.message.findUnique({
        where: { id: dto.parentId },
        select: { authorId: true },
      });
      if (parent?.authorId && parent.authorId !== userId) {
        await this.prisma.notification.create({
          data: {
            userId: parent.authorId,
            type: 'reply',
            title: 'New reply to your message',
            body: dto.content.substring(0, 200),
            entityType: dto.entityType,
            entityId: dto.entityId,
            actorId: userId,
            messageId: message.id,
          },
        });
      }
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

  async resolveThread(messageId: number, userId: number) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, parentId: null },
    });
    if (!message) throw new NotFoundException('Thread not found');

    return this.prisma.message.update({
      where: { id: messageId },
      data: { metadata: { ...(message.metadata as any ?? {}), resolved: true, resolvedBy: userId, resolvedAt: new Date().toISOString() } },
      include: messageInclude,
    });
  }

  async unresolveThread(messageId: number) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, parentId: null },
    });
    if (!message) throw new NotFoundException('Thread not found');

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

  async search(query: string, userId: number, options?: { entityType?: string; page?: number; perPage?: number }) {
    const page = options?.page ?? 1;
    const perPage = options?.perPage ?? 20;
    const skip = (page - 1) * perPage;

    const where: Prisma.MessageWhereInput = {
      deletedAt: null,
      content: { contains: query },
      ...(options?.entityType ? { entityType: options.entityType as MessageEntityType } : {}),
    };

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

  async getAnalytics(projectId?: number) {
    const where: Prisma.MessageWhereInput = {
      deletedAt: null,
      ...(projectId ? { entityType: 'project', entityId: projectId } : {}),
    };

    const [totalMessages, totalThreads, unresolvedThreads, mentionCount, recentActivity] = await Promise.all([
      this.prisma.message.count({ where }),
      this.prisma.message.count({ where: { ...where, parentId: null } }),
      this.prisma.message.count({
        where: {
          ...where,
          parentId: null,
          OR: [
            { metadata: { equals: Prisma.DbNull } },
            { metadata: { path: 'resolved', equals: Prisma.AnyNull } },
          ],
        },
      }),
      this.prisma.messageMention.count(),
      this.prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { author: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);

    // Calculate average response time for threads with replies
    const threadsWithReplies = await this.prisma.message.findMany({
      where: { ...where, parentId: null, replies: { some: { deletedAt: null } } },
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
        ...where,
        OR: urgentKeywords.map((kw) => ({ content: { contains: kw } })),
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

  async suggestRecipients(entityType: MessageEntityType, entityId: number) {
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

  async summarizeThread(messageId: number) {
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

  async findByEntity(dto: QueryMessagesDto) {
    const where: Prisma.MessageWhereInput = {
      deletedAt: null,
      parentId: null, // top-level messages only
    };

    if (dto.entityType) where.entityType = dto.entityType as MessageEntityType;
    if (dto.entityId) where.entityId = dto.entityId;

    const [data, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
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
      this.prisma.message.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: dto.page ?? 1,
        perPage: dto.perPage ?? 20,
        totalPages: Math.ceil(total / (dto.perPage ?? 20)),
      },
    };
  }

  async findOne(id: number) {
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
    return message;
  }

  async update(id: number, userId: number, content: string) {
    const message = await this.prisma.message.findFirst({
      where: { id, deletedAt: null },
    });

    if (!message) throw new NotFoundException('Message not found');
    if (message.authorId !== userId) throw new ForbiddenException('Can only edit own messages');

    return this.prisma.message.update({
      where: { id },
      data: { content, isEdited: true },
      include: messageInclude,
    });
  }

  async remove(id: number, userId: number) {
    const message = await this.prisma.message.findFirst({
      where: { id, deletedAt: null },
    });

    if (!message) throw new NotFoundException('Message not found');
    // Allow author or admin to delete
    if (message.authorId !== userId) {
      // TODO: check admin role
    }

    await this.prisma.message.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'Message deleted' };
  }

  async getInbox(userId: number, page = 1, perPage = 20) {
    const skip = (page - 1) * perPage;

    // Messages where user is mentioned or is the author of a reply
    const where: Prisma.MessageWhereInput = {
      deletedAt: null,
      OR: [
        { mentions: { some: { userId } } },
        {
          replies: {
            some: { authorId: userId, deletedAt: null },
          },
        },
      ],
      parentId: null, // only top-level
    };

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
      data,
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
