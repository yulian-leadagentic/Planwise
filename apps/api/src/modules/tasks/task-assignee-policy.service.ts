import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { isInternalUserType } from '../../common/people/internal-employee';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';

/**
 * QA6 package 1 (2026-11-25) — assigning a task is not a way into a
 * project.
 *
 * Every path that adds a TaskAssignee for someone other than the caller
 * of a personal task goes through `ensureAssignable` first. Today that
 * is POST /tasks/:id/assignees, which the task drawer, the planning
 * grid's per-row picker, its bulk-assign bar and the weekly timesheet
 * all call (task create takes no assignees, except a personal task's
 * own creator).
 *
 *   • External contacts are never assignable (400 ASSIGNEE_EXTERNAL_CONTACT).
 *   • Personal task (no project): any internal employee, as before.
 *   • Target already on the Team (leader, creator, member, active
 *     partner role): assign as before.
 *   • Otherwise only the project leader or an Admin
 *     (`assertProjectManage`) may assign him: he first gets a
 *     `participant` role on the Team (`upsertProjectMemberRelationship`,
 *     audited as a team add), then the assignment is written. Anyone
 *     else: 403 ASSIGNEE_NOT_ON_TEAM.
 *
 * `participant` has no partner-role eligibility check on this path
 * (upsertProjectMemberRelationship writes the row directly), so a user
 * whose person BP lacks the 'employee' partner role is added all the same.
 */
@Injectable()
export class TaskAssigneePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly partnerRoles: ProjectPartnerRolesService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async ensureAssignable(
    actor: { id: number } & Record<string, any>,
    projectId: number | null,
    userId: number,
    taskId?: number,
  ): Promise<{ addedToTeam: boolean }> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, isActive: true, userType: true },
    });
    if (!target) throw new NotFoundException(`User ${userId} not found`);
    const name = `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim() || `User #${target.id}`;

    if (!target.isActive) {
      throw new BadRequestException(`Cannot assign task to inactive user (${name}). Reactivate the user first.`);
    }
    if (!isInternalUserType(target.userType)) {
      throw new BadRequestException({
        code: 'ASSIGNEE_EXTERNAL_CONTACT',
        message: `${name} is an external contact, not an employee. Only employees can be assigned to tasks.`,
      });
    }

    if (projectId == null) return { addedToTeam: false };
    if (await this.access.isOnProjectTeam(userId, projectId)) return { addedToTeam: false };

    if (!(await this.access.canManageProject(actor, projectId))) {
      throw new PermissionDeniedException(
        `${name} is not on this project's team. Only the project leader or an administrator can add someone new to the project.`,
        { module: 'projects', reason: 'ASSIGNEE_NOT_ON_TEAM' },
      );
    }

    const role = await this.partnerRoles.upsertProjectMemberRelationship({ userId, projectId });
    if (!role) {
      throw new BadRequestException({
        code: 'TEAM_ROLE_MISSING',
        message: `Could not add ${name} to the project team: the "participant" project role is missing. Ask an administrator.`,
      });
    }

    const project = await this.prisma.project.findFirst({ where: { id: projectId }, select: { name: true } });
    await this.activityLog.logProjectMemberAdded({
      actorUserId: actor.id,
      projectId,
      entityId: userId,
      projectName: project?.name ?? `Project #${projectId}`,
      memberName: name,
      metadata: { via: 'task-assign', taskId: taskId ?? null, role: 'participant' },
    });
    return { addedToTeam: true };
  }
}
