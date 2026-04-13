import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MessagesService } from './messages.service';

/**
 * Listens for domain events and creates system messages + notifications automatically.
 */
@Injectable()
export class SystemMessagesListener {
  private readonly logger = new Logger(SystemMessagesListener.name);

  constructor(
    private prisma: PrismaService,
    private messagesService: MessagesService,
  ) {}

  @OnEvent('task.status.changed')
  async handleTaskStatusChanged(payload: {
    taskId: number;
    projectId: number;
    userId: number;
    oldStatus: string;
    newStatus: string;
    userName: string;
  }) {
    const { taskId, projectId, userId, oldStatus, newStatus, userName } = payload;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { name: true, zoneId: true },
    });
    if (!task) return;

    const content = `${userName} changed status from "${this.formatStatus(oldStatus)}" to "${this.formatStatus(newStatus)}"`;

    await this.messagesService.createSystemMessage('task', taskId, content, {
      event: 'task.status.changed',
      oldStatus,
      newStatus,
      userId,
    });

    // Notify task assignees
    const assignees = await this.prisma.taskAssignee.findMany({
      where: { taskId, deletedAt: null },
      select: { userId: true },
    });

    if (assignees.length > 0) {
      await this.prisma.notification.createMany({
        data: assignees
          .filter((a) => a.userId !== userId)
          .map((a) => ({
            userId: a.userId,
            type: 'status_change',
            title: `Task "${task.name}" status changed`,
            body: content,
            entityType: 'task',
            entityId: taskId,
            actorId: userId,
          })),
      });
    }

    this.logger.log(`System message created: task ${taskId} status ${oldStatus} → ${newStatus}`);
  }

  @OnEvent('task.assignee.added')
  async handleTaskAssigneeAdded(payload: {
    taskId: number;
    userId: number;
    assigneeId: number;
    userName: string;
    assigneeName: string;
  }) {
    const { taskId, userId, assigneeId, userName, assigneeName } = payload;

    const content = `${userName} assigned ${assigneeName} to this task`;

    await this.messagesService.createSystemMessage('task', taskId, content, {
      event: 'task.assignee.added',
      assigneeId,
      userId,
    });

    // Notify the assignee
    if (assigneeId !== userId) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { name: true },
      });

      await this.prisma.notification.create({
        data: {
          userId: assigneeId,
          type: 'assignment',
          title: `You were assigned to "${task?.name || 'a task'}"`,
          body: content,
          entityType: 'task',
          entityId: taskId,
          actorId: userId,
        },
      });
    }
  }

  @OnEvent('project.status.changed')
  async handleProjectStatusChanged(payload: {
    projectId: number;
    userId: number;
    oldStatus: string;
    newStatus: string;
    userName: string;
  }) {
    const { projectId, userId, oldStatus, newStatus, userName } = payload;

    const content = `${userName} changed project status from "${this.formatStatus(oldStatus)}" to "${this.formatStatus(newStatus)}"`;

    await this.messagesService.createSystemMessage('project', projectId, content, {
      event: 'project.status.changed',
      oldStatus,
      newStatus,
      userId,
    });

    // Notify project members
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });

    if (members.length > 0) {
      await this.prisma.notification.createMany({
        data: members
          .filter((m) => m.userId !== userId)
          .map((m) => ({
            userId: m.userId,
            type: 'status_change',
            title: 'Project status changed',
            body: content,
            entityType: 'project',
            entityId: projectId,
            actorId: userId,
          })),
      });
    }
  }

  @OnEvent('project.member.added')
  async handleProjectMemberAdded(payload: {
    projectId: number;
    userId: number;
    memberId: number;
    userName: string;
    memberName: string;
  }) {
    const { projectId, userId, memberId, userName, memberName } = payload;

    const content = `${userName} added ${memberName} to the project`;

    await this.messagesService.createSystemMessage('project', projectId, content, {
      event: 'project.member.added',
      memberId,
    });

    // Notify the new member
    if (memberId !== userId) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
      });

      await this.prisma.notification.create({
        data: {
          userId: memberId,
          type: 'assignment',
          title: `You were added to project "${project?.name || ''}"`,
          body: content,
          entityType: 'project',
          entityId: projectId,
          actorId: userId,
        },
      });
    }
  }

  private formatStatus(status: string): string {
    return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
