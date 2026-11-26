import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as nodemailer from 'nodemailer';

import { PrismaService } from '../../prisma/prisma.service';

/** One outgoing e-mail. `template` is a short name recorded in email_logs. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  template: string;
  text: string;
  html?: string;
}

/** Minimal shape of the nodemailer transport we use (the package ships no types). */
interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export interface CreateNotificationInput {
  userId: number;
  type: string;
  title: string;
  body?: string;
  data?: any;
  /** QA6 (2026-11-26) · optional, written to the existing columns: what the bell opens and who caused it. */
  entityType?: string;
  entityId?: number;
  actorId?: number;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  /** Lazily built SMTP transport; `null` = not configured (checked once). */
  private transport: MailTransport | null | undefined;

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    // Optional so existing `new NotificationsService(prisma, emitter)`
    // call sites (specs) keep compiling; Nest always injects it.
    @Optional() private config?: ConfigService,
  ) {}

  async create(input: CreateNotificationInput) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
        ...(input.entityType != null ? { entityType: input.entityType } : {}),
        ...(input.entityId != null ? { entityId: input.entityId } : {}),
        ...(input.actorId != null ? { actorId: input.actorId } : {}),
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

  /**
   * Send one e-mail over SMTP and record the attempt in `email_logs`.
   *
   * Permissions round 3 (2026-11-22) — this used to only write an
   * email_logs row marked "sent" without sending anything. It now
   * sends through nodemailer, configured from the environment:
   *
   *   MAIL_HOST (required — unset = e-mail disabled), MAIL_PORT
   *   (default 587; 465 = implicit TLS), MAIL_USER + MAIL_PASSWORD
   *   (optional SMTP auth), MAIL_FROM (sender; falls back to MAIL_USER).
   *
   * Never throws: returns true when the server accepted the message,
   * false otherwise (not configured, rejected, network error) — with a
   * `failed` email_logs row carrying the reason. The body is never
   * logged or stored (it may hold a one-time code).
   */
  async sendEmail(message: OutgoingEmail): Promise<boolean> {
    const transport = this.getTransport();
    let status: 'sent' | 'failed' = 'failed';
    let errorMessage: string | null = null;

    if (!transport) {
      errorMessage = 'E-mail is not configured (MAIL_HOST is not set).';
    } else {
      try {
        await transport.sendMail({
          from: this.mailFrom(),
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        });
        status = 'sent';
      } catch (error: any) {
        errorMessage = String(error?.message ?? error).slice(0, 500);
        this.logger.warn(`e-mail "${message.template}" failed: ${errorMessage}`);
      }
    }

    try {
      await this.prisma.emailLog.create({
        data: {
          toEmail: message.to,
          subject: message.subject,
          template: message.template,
          status,
          errorMessage,
        },
      });
    } catch (error: any) {
      this.logger.warn(`email_logs write failed: ${error?.message ?? error}`);
    }
    return status === 'sent';
  }

  /** True when SMTP settings are present (MAIL_HOST). */
  isEmailConfigured(): boolean {
    return this.getTransport() != null;
  }

  private env(key: string): string | undefined {
    const v = this.config?.get<string>(key) ?? process.env[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }

  private mailFrom(): string {
    return this.env('MAIL_FROM') ?? this.env('MAIL_USER') ?? 'no-reply@planwise.local';
  }

  private getTransport(): MailTransport | null {
    if (this.transport !== undefined) return this.transport;
    const host = this.env('MAIL_HOST');
    if (!host) {
      this.logger.warn('E-mail is disabled: MAIL_HOST is not set. Outgoing e-mails are logged as failed.');
      this.transport = null;
      return null;
    }
    const port = Number(this.env('MAIL_PORT') ?? 587);
    const user = this.env('MAIL_USER');
    const pass = this.env('MAIL_PASSWORD');
    this.transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      ...(user ? { auth: { user, pass } } : {}),
    }) as MailTransport;
    return this.transport;
  }
}
