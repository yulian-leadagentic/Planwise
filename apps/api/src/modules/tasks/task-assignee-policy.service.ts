import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { isInternalUserType } from '../../common/people/internal-employee';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';

/** What `planAssignment` decided for one (project, person) pair. */
export interface AssignmentPlan {
  userId: number;
  projectId: number | null;
  /** Display name, for messages and the audit line. */
  name: string;
  /** He is not on the Team yet and the actor may add him: a `participant` role is written first. */
  needsTeamAdd: boolean;
}

/**
 * QA6 package 1 (2026-11-25) — assigning a task is not a way into a
 * project.
 *
 * Every path that makes someone an assignee of a project task goes
 * through `planAssignment` before anything is written:
 *   • POST /tasks/:id/assignees (the task drawer, the planning grid's
 *     per-row picker and bulk-assign bar, the weekly timesheet);
 *   • PATCH /tasks/:id that moves a task WITHOUT a project into one
 *     (`zoneId` / `projectId`): every live assignee is planned against
 *     the new project, except the task's creator assigned to his own
 *     task (security review 25.11 — a personal task with any employee
 *     on it could otherwise carry him into a project nobody added him
 *     to). Task create writes no assignee but the creator of a personal
 *     task himself, which is that same exception.
 *
 * The rule:
 *   • External contacts are never assignable (400 ASSIGNEE_EXTERNAL_CONTACT).
 *   • Personal task (no project): any internal employee, as before.
 *   • Target already on the Team (leader, creator, member, active
 *     partner role): assign as before.
 *   • Otherwise only the project leader or an Admin
 *     (`assertProjectManage`) may assign him: he gets a `participant`
 *     role on the Team (`upsertProjectMemberRelationship`, audited as a
 *     team add) IN THE SAME TRANSACTION as the assignment / the move, so
 *     a failed write never leaves a role behind. Anyone else: 403
 *     ASSIGNEE_NOT_ON_TEAM, and nothing is written.
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

  /** Read-only: throws when `userId` may not be assigned on `projectId` by `actor`. */
  async planAssignment(
    actor: { id: number } & Record<string, any>,
    projectId: number | null,
    userId: number,
  ): Promise<AssignmentPlan> {
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

    const plan: AssignmentPlan = { userId, projectId, name, needsTeamAdd: false };
    if (projectId == null) return plan;
    if (await this.access.isOnProjectTeam(userId, projectId)) return plan;

    if (!(await this.access.canManageProject(actor, projectId))) {
      throw new PermissionDeniedException(
        `${name} is not on this project's team. Only the project leader or an administrator can add someone new to the project.`,
        { module: 'projects', reason: 'ASSIGNEE_NOT_ON_TEAM' },
      );
    }
    return { ...plan, needsTeamAdd: true };
  }

  /** Writes the plan's `participant` role (inside `tx` when given). No-op when none is needed. */
  async applyTeamAdd(plan: AssignmentPlan, tx?: Prisma.TransactionClient): Promise<void> {
    if (!plan.needsTeamAdd || plan.projectId == null) return;
    const role = await this.partnerRoles.upsertProjectMemberRelationship(
      { userId: plan.userId, projectId: plan.projectId },
      tx,
    );
    if (!role) {
      throw new BadRequestException({
        code: 'TEAM_ROLE_MISSING',
        message: `Could not add ${plan.name} to the project team: the "participant" project role is missing. Ask an administrator.`,
      });
    }
  }

  /** The audit line of a team add. Call AFTER the transaction committed. */
  async logTeamAdd(actor: { id: number }, plan: AssignmentPlan, taskId?: number | null): Promise<void> {
    if (!plan.needsTeamAdd || plan.projectId == null) return;
    const project = await this.prisma.project.findFirst({ where: { id: plan.projectId }, select: { name: true } });
    await this.activityLog.logProjectMemberAdded({
      actorUserId: actor.id,
      projectId: plan.projectId,
      entityId: plan.userId,
      projectName: project?.name ?? `Project #${plan.projectId}`,
      memberName: plan.name,
      metadata: { via: 'task-assign', taskId: taskId ?? null, role: 'participant' },
    });
  }
}
