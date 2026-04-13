import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
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
  constructor(private prisma: PrismaService) {}

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
    return this.prisma.message.findUnique({
      where: { id: message.id },
      include: {
        ...messageInclude,
        mentions: { include: { user: { select: authorSelect } } },
      },
    });
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
