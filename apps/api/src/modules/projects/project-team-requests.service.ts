import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { isAdminUser } from '../../common/guards/roles.guard';
import { isInternalEmployee } from '../../common/people/internal-employee';
import { NotificationsService } from '../notifications/notifications.service';

/** Activity Log action of a request; also what the 24-hour check reads. */
export const TEAM_JOIN_REQUEST_ACTION = 'team_join_request';
/** Notification type the project manager receives. */
export const TEAM_JOIN_REQUEST_NOTIFICATION = 'team_join_request';
/** A second request inside this window does not notify again. */
export const TEAM_JOIN_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TeamJoinRequestResult {
  /** True when an earlier request (same user, same project) is less than 24 hours old: nobody was notified now. */
  alreadyRequested: boolean;
  /** When the request that counts was made: now, or the earlier one. ISO 8601. */
  requestedAt: string;
}

/**
 * QA6 decision 2 (26.11) — an employee who sees a project only through
 * his org unit or his manager chain (ProjectAccessService rules 6 / 7)
 * is not on its Team, so he cannot assign himself to a task (403
 * ASSIGNEE_NOT_ON_TEAM, TaskAssigneePolicyService). Instead he asks the
 * project manager to add him: this sends the leader (no leader: the
 * creator) an in-app notification that opens the project's Team tab,
 * and writes the project's Activity Log. Adding him stays the leader's /
 * an Admin's call (the Team tab), as in package 1.
 *
 * Idempotent per (user, project) for 24 hours: the Activity Log row IS
 * the record of the request (`action = team_join_request`, the caller in
 * `userId`, the project in `projectId`, read through the
 * (project_id, created_at) index), so no table is added. A repeat inside
 * the window notifies nobody and answers `{ alreadyRequested: true }`.
 * The Activity Log write is best-effort (ActivityLogService swallows its
 * errors), so a failed log row only means a repeat would notify again.
 */
@Injectable()
export class ProjectTeamRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly notifications: NotificationsService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async requestToJoin(
    caller: { id: number } & Record<string, any>,
    projectId: number,
    now: Date = new Date(),
  ): Promise<TeamJoinRequestResult> {
    // 404 for a missing project, 403 NOT_PROJECT_MEMBER without access.
    await this.access.assertProjectAccess(caller.id, projectId, isAdminUser(caller));

    const me = await this.prisma.user.findFirst({
      where: { id: caller.id, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, userType: true, isActive: true, deletedAt: true },
    });
    if (!isInternalEmployee(me)) {
      throw new PermissionDeniedException(
        'Only employees can ask to join a project team. Ask the project leader if you need access.',
        { module: 'projects', reason: 'TEAM_REQUEST_NOT_EMPLOYEE' },
      );
    }
    if (await this.access.isOnProjectTeam(caller.id, projectId)) {
      throw new ConflictException({
        code: 'ALREADY_ON_TEAM',
        message: "You're already on this project's team.",
      });
    }

    const since = new Date(now.getTime() - TEAM_JOIN_REQUEST_WINDOW_MS);
    const earlier = await this.prisma.activityLog.findFirst({
      where: { projectId, userId: caller.id, action: TEAM_JOIN_REQUEST_ACTION, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (earlier) {
      return { alreadyRequested: true, requestedAt: earlier.createdAt.toISOString() };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, leaderId: true, createdBy: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const managerId = await this.resolveManagerId(project);
    if (managerId == null) {
      throw new ConflictException({
        code: 'NO_PROJECT_MANAGER',
        message: 'This project has no leader to ask. Ask an administrator to add you to the team.',
      });
    }

    const name = `${me!.firstName ?? ''} ${me!.lastName ?? ''}`.trim() || `User #${me!.id}`;
    const projectName = project.name ?? `Project #${project.id}`;
    const link = `/projects/${project.id}?projectTab=team`;

    await this.notifications.create({
      userId: managerId,
      type: TEAM_JOIN_REQUEST_NOTIFICATION,
      title: `${name} asked to join the team of ${projectName}`,
      body: 'Open the Team tab to add them to the project.',
      entityType: 'project',
      entityId: project.id,
      actorId: caller.id,
      data: { projectId: project.id, requesterId: caller.id, link },
    });

    await this.activityLog.write({
      category: 'project',
      action: TEAM_JOIN_REQUEST_ACTION,
      entityType: 'project_member',
      entityId: caller.id,
      entityName: name,
      projectId: project.id,
      actorUserId: caller.id,
      description: `${name} asked the project manager to be added to the team`,
      metadata: { notifiedUserId: managerId },
    });

    return { alreadyRequested: false, requestedAt: now.toISOString() };
  }

  /** The project leader when he is an active user, else the creator when he is; null when neither. */
  private async resolveManagerId(project: { leaderId: number | null; createdBy: number | null }): Promise<number | null> {
    for (const id of [project.leaderId, project.createdBy]) {
      if (id == null) continue;
      const user = await this.prisma.user.findFirst({
        where: { id, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (user) return user.id;
    }
    return null;
  }
}
