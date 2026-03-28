import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';

export interface CreateNotificationInput {
  userId: number;
  type: string;
  title: string;
  body?: string;
  data?: any;
}

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(input: CreateNotificationInput) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
      },
    });

    // Emit event for WebSocket push
    this.eventEmitter.emit('notification.created', notification);

    return notification;
  }

  async findAll(userId: number, options: { unreadOnly: boolean; page: number; perPage: number }) {
    const where: any = { userId };
    if (options.unreadOnly) {
      where.readAt = null;
    }

    const skip = (options.page - 1) * options.perPage;

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: options.perPage,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return {
      data,
      meta: {
        total,
        page: options.page,
        perPage: options.perPage,
        totalPages: Math.ceil(total / options.perPage),
        unreadCount,
      },
    };
  }

  async markRead(id: number, userId: number) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: number) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    return { message: 'All notifications marked as read' };
  }

  async sendEmail(to: string, subject: string, template: string, context: any) {
    try {
      // In production, use @nestjs-modules/mailer
      // For now, log the email and store in email_logs
      await this.prisma.emailLog.create({
        data: {
          toEmail: to,
          subject,
          template,
          status: 'sent',
        },
      });
    } catch (error: any) {
      await this.prisma.emailLog.create({
        data: {
          toEmail: to,
          subject,
          template,
          status: 'failed',
          errorMessage: error.message,
        },
      });
    }
  }
}
