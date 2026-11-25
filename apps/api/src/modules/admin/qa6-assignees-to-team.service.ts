import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { activePartnerRoleWhere } from '../../common/services/project-access.service';
import { isInternalEmployee } from '../../common/people/internal-employee';
import { ProjectPartnerRolesService } from '../project-partner-roles/project-partner-roles.service';

/** One (project, person) pair: a live assignee who is not on the project's Team. */
export interface Qa6AssigneeRow {
  projectId: number;
  projectName: string;
  userId: number;
  userName: string;
  /** Live tasks of the project he is a live assignee of. */
  taskCount: number;
}

export type Qa6SkipReason = 'EXTERNAL_CONTACT' | 'INACTIVE_USER' | 'USER_DELETED';

export interface Qa6AssigneesToTeamResult {
  dryRun: boolean;
  /** Who gets a `participant` role (dry-run: would get). */
  toAdd: Qa6AssigneeRow[];
  /** Not on the Team and NOT added, with the reason. */
  skipped: Array<Qa6AssigneeRow & { reason: Qa6SkipReason }>;
  totals: { toAdd: number; skipped: number; projects: number };
  /** Real run only; 0 on a dry-run. */
  rolesWritten: number;
}

/** `dryRun` is true unless the body says exactly `false`. */
export function parseQa6AssigneesToTeamBody(body: unknown): { dryRun: boolean } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return { dryRun: raw.dryRun !== false };
}

/**
 * QA6 package 1 — `POST /admin/backfills/qa6-assignees-to-team`.
 *
 * Round 4 rule 5 let any task assignee into the whole project. QA6
 * removed it, so every live assignee of a live project task who is not
 * on that project's Team (leader, creator, ProjectMember row or active
 * partner role, the same test as ProjectAccessService.isOnProjectTeam)
 * gets a `participant` role, through the same
 * `upsertProjectMemberRelationship` the leader's add-to-team uses.
 *
 * Internal employees only (owner decision 25.11, question 1): external
 * contacts, inactive and deleted users are listed under `skipped` with
 * the reason and never written. Personal tasks that are linked to a
 * project count like any other task of it.
 *
 * Idempotent: an added person is on the Team, so the next run lists
 * nothing for him.
 */
@Injectable()
export class Qa6AssigneesToTeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partnerRoles: ProjectPartnerRolesService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async run(opts: { dryRun: boolean; actorId?: number }): Promise<Qa6AssigneesToTeamResult> {
    const { toAdd, skipped } = await this.plan();
    let rolesWritten = 0;
    if (!opts.dryRun) {
      for (const row of toAdd) {
        const role = await this.partnerRoles.upsertProjectMemberRelationship({
          userId: row.userId,
          projectId: row.projectId,
        });
        if (!role) continue;
        rolesWritten++;
        await this.activityLog.logProjectMemberAdded({
          actorUserId: opts.actorId ?? null,
          projectId: row.projectId,
          entityId: row.userId,
          projectName: row.projectName,
          memberName: row.userName,
          metadata: { via: 'backfill:qa6-assignees-to-team', role: 'participant', taskCount: row.taskCount },
        });
      }
    }
    return {
      dryRun: opts.dryRun,
      toAdd,
      skipped,
      totals: {
        toAdd: toAdd.length,
        skipped: skipped.length,
        projects: new Set([...toAdd, ...skipped].map((r) => r.projectId)).size,
      },
      rolesWritten,
    };
  }

  /** Read-only: the pairs to add and the pairs skipped. */
  async plan(): Promise<{ toAdd: Qa6AssigneeRow[]; skipped: Array<Qa6AssigneeRow & { reason: Qa6SkipReason }> }> {
    // Live assignments on live tasks of live projects.
    const assignments = await this.prisma.taskAssignee.findMany({
      where: {
        deletedAt: null,
        task: { deletedAt: null, projectId: { not: null }, project: { deletedAt: null } },
      },
      select: { userId: true, taskId: true, task: { select: { projectId: true } } },
    });

    const tasksByPair = new Map<string, { projectId: number; userId: number; taskIds: Set<number> }>();
    for (const a of assignments) {
      const projectId = a.task?.projectId;
      if (projectId == null) continue;
      const key = `${projectId}:${a.userId}`;
      const pair = tasksByPair.get(key) ?? { projectId, userId: a.userId, taskIds: new Set<number>() };
      pair.taskIds.add(a.taskId);
      tasksByPair.set(key, pair);
    }
    if (tasksByPair.size === 0) return { toAdd: [], skipped: [] };

    const projectIds = [...new Set([...tasksByPair.values()].map((p) => p.projectId))];
    const userIds = [...new Set([...tasksByPair.values()].map((p) => p.userId))];

    const [projects, members, roles, users] = await Promise.all([
      this.prisma.project.findMany({
        where: { id: { in: projectIds }, deletedAt: null },
        select: { id: true, name: true, leaderId: true, createdBy: true },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId: { in: projectIds } },
        select: { projectId: true, userId: true },
      }),
      this.prisma.projectPartnerRole.findMany({
        where: { projectId: { in: projectIds }, ...activePartnerRoleWhere(new Date()) },
        select: { projectId: true, party: { select: { user: { select: { id: true } } } } },
      }),
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, userType: true, isActive: true, deletedAt: true },
      }),
    ]);

    const onTeam = new Set<string>();
    for (const p of projects) {
      if (p.leaderId != null) onTeam.add(`${p.id}:${p.leaderId}`);
      if (p.createdBy != null) onTeam.add(`${p.id}:${p.createdBy}`);
    }
    for (const m of members) onTeam.add(`${m.projectId}:${m.userId}`);
    for (const r of roles) {
      const uid = r.party?.user?.id;
      if (uid != null) onTeam.add(`${r.projectId}:${uid}`);
    }
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const userById = new Map(users.map((u) => [u.id, u]));

    const toAdd: Qa6AssigneeRow[] = [];
    const skipped: Array<Qa6AssigneeRow & { reason: Qa6SkipReason }> = [];
    for (const [key, pair] of tasksByPair) {
      if (onTeam.has(key)) continue;
      const project = projectById.get(pair.projectId);
      if (!project) continue;
      const user = userById.get(pair.userId);
      const row: Qa6AssigneeRow = {
        projectId: pair.projectId,
        projectName: project.name,
        userId: pair.userId,
        userName: user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || `User #${user.id}` : `User #${pair.userId}`,
        taskCount: pair.taskIds.size,
      };
      if (!user || user.deletedAt != null) skipped.push({ ...row, reason: 'USER_DELETED' });
      else if (!user.isActive) skipped.push({ ...row, reason: 'INACTIVE_USER' });
      else if (!isInternalEmployee(user)) skipped.push({ ...row, reason: 'EXTERNAL_CONTACT' });
      else toAdd.push(row);
    }
    const order = (a: Qa6AssigneeRow, b: Qa6AssigneeRow) =>
      a.projectName.localeCompare(b.projectName) || a.userName.localeCompare(b.userName) || a.userId - b.userId;
    return { toAdd: toAdd.sort(order), skipped: skipped.sort(order) };
  }
}
