import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionDeniedException } from '../errors/permission-denied';
import { isAdminUser } from '../guards/roles.guard';

/** What the caller tried to open — only changes the wording of the 403. */
type AccessSubject = 'project' | 'task' | 'zone';

const ASK_TO_BE_ADDED = 'Ask the project leader or an administrator to add you.';

/**
 * Permission messages (2026-11-20) — the "not a member" refusal, in
 * plain words, with the PERMISSION_DENIED code.
 */
function notProjectMember(subject: AccessSubject): PermissionDeniedException {
  const lead =
    subject === 'project'
      ? "You're not a member of this project."
      : `This ${subject} belongs to a project you're not a member of.`;
  return new PermissionDeniedException(`${lead} ${ASK_TO_BE_ADDED}`, {
    module: 'projects',
    reason: 'NOT_PROJECT_MEMBER',
  });
}

/** Round 4: the team, leader, settings, close and delete are leader-or-Admin. */
function notProjectLeader(): PermissionDeniedException {
  return new PermissionDeniedException(
    "Only the project leader or an administrator can change this project's team or settings.",
    { module: 'projects', reason: 'NOT_PROJECT_LEADER' },
  );
}

/** An active partner-role row: the same window the Team tab shows. */
export function activePartnerRoleWhere(now: Date): Prisma.ProjectPartnerRoleWhereInput {
  return { status: 'active', validFrom: { lte: now }, validTo: { gt: now } };
}

/**
 * Centralizes project-scoped authorization. Use this in any service that
 * accepts a project/zone/task ID from a request to make sure the caller
 * is actually a member of that project (or an admin).
 *
 * Without this check, any authenticated user with `tasks:read` permission
 * could read another tenant's tasks by guessing IDs (IDOR).
 *
 * Hierarchical access (feat/org-access)
 * -------------------------------------
 * A manager of an OrgUnit implicitly sees the projects of every user
 * whose home unit sits in that manager's subtree — unlimited depth. The
 * unit-membership computation happens via the materialised `path`
 * column on OrgUnit (`startsWith` of the manager's own unit path), so a
 * single indexed query resolves the entire subtree without recursion.
 *
 * The extension is ADDITIVE: an installation with no org units + no
 * managers gets an empty subordinate set, which short-circuits every
 * hierarchy-aware branch below. Behaviour there is bit-for-bit
 * identical to the pre-feature access checks.
 *
 * The access rule (permissions round 4, 2026-11-23; QA6 2026-11-25).
 * A user has access to a project when any of these holds:
 *   1. Admin (`isAdminUser`).
 *   2. Leader or creator.
 *   3. A ProjectMember row.
 *   4. An active ProjectPartnerRole whose party is the user's own
 *      BusinessPartner (the Team tab).
 *   5. REMOVED in QA6 (was "assignee of any live task"). Assigning a
 *      task is no longer a way into a project: an assignee must already
 *      be on the Team (2–4), and only the leader or an Admin can add a
 *      new person, as a `participant` role, while assigning him
 *      (TaskAssigneePolicyService). The `qa6-assignees-to-team` backfill
 *      gave every earlier assignee that role. Numbers 6 and 7 are kept
 *      so existing references stay valid.
 *   6. Home OrgUnit equals the project's OrgUnit (exact match).
 *   7. Manager, at any depth, of a user admitted by 2–4.
 * Rules 2–4 together are "on the Team" (`isOnProjectTeam`).
 * Every admitted user has full read and write. Managing the project
 * (team, leader, settings, close, delete) is leader-or-Admin:
 * `assertProjectManage` / `canManageProject`.
 */
@Injectable()
export class ProjectAccessService {
  /**
   * Per-request-ish memo of getSubordinateUserIds. Kept on the service
   * instance (singleton) rather than via Scope.REQUEST because REQUEST
   * scope cascades to every consumer of this service, which would
   * ripple through the entire access layer.
   *
   * Trade-off: this cache lives for the process, not the request. To
   * keep it honest under org-tree edits, both callers that mutate the
   * org tree (OrgUnitService.setManager / assignUser / move) invalidate
   * it via invalidateSubordinateCache(). Read paths simply reuse.
   *
   * A future refactor can flip to a ClsService-backed per-request cache
   * without touching call sites.
   */
  private subordinatesMemo = new Map<number, Promise<number[]>>();

  constructor(private prisma: PrismaService) {}

  /**
   * Clear the subordinate memo. Called by OrgUnitService whenever the
   * tree structure or a home-unit assignment changes so stale entries
   * don't outlive the mutation. Cheap — the memo is bounded by the
   * number of distinct managers per process.
   */
  invalidateSubordinateCache(userId?: number): void {
    if (userId == null) this.subordinatesMemo.clear();
    else this.subordinatesMemo.delete(userId);
  }

  /**
   * Admins see everything. Permissions round 1 (2026-11-20): callers
   * pass `isAdminUser(request.user)` (the same multi-role definition
   * the RolesGuard uses) instead of the legacy `roleId === 1`. The
   * strict `=== true` makes a stale caller that still passes a numeric
   * roleId fail closed (no bypass) instead of failing open.
   */
  private adminBypass(isAdmin: boolean): boolean {
    return isAdmin === true;
  }

  /**
   * Throws PermissionDeniedException (403, NOT_PROJECT_MEMBER) unless the
   * access rule above admits `userId` to `projectId`. Throws
   * NotFoundException if the project does not exist (or is soft-deleted).
   */
  async assertProjectAccess(
    userId: number,
    projectId: number,
    isAdmin: boolean,
  ): Promise<void> {
    return this.assertProjectMembership(userId, projectId, isAdmin, 'project');
  }

  /** Body of assertProjectAccess; `subject` only picks the 403 wording. */
  private async assertProjectMembership(
    userId: number,
    projectId: number,
    isAdmin: boolean,
    subject: AccessSubject,
  ): Promise<void> {
    if (this.adminBypass(isAdmin)) return;

    // Rule 2 (leader / creator) and rule 6 (org unit) read this one row.
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, leaderId: true, createdBy: true, orgUnitId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (project.leaderId === userId || project.createdBy === userId) return;

    // Rules 3–4: member row, partner role.
    if (await this.anyUserOnProject([userId], projectId)) return;

    // Rule 6: exact org-unit match.
    const projectOrgUnitId = project.orgUnitId ?? null;
    if (projectOrgUnitId != null) {
      const caller = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { orgUnitId: true },
      });
      if (caller?.orgUnitId === projectOrgUnitId) return;
    }

    // Rule 7: a manager of someone admitted by rules 2–4.
    const subs = await this.getSubordinateUserIds(userId);
    if (subs.length > 0) {
      if (project.leaderId != null && subs.includes(project.leaderId)) return;
      if (project.createdBy != null && subs.includes(project.createdBy)) return;
      if (await this.anyUserOnProject(subs, projectId)) return;
    }

    throw notProjectMember(subject);
  }

  /**
   * Rules 3–4 for a set of users: any of them has a ProjectMember row or
   * an active partner role through his own BusinessPartner. (A task
   * assignment no longer counts: QA6 removed rule 5.)
   */
  private async anyUserOnProject(userIds: number[], projectId: number): Promise<boolean> {
    if (userIds.length === 0) return false;

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: { in: userIds } },
      select: { id: true },
    });
    if (membership) return true;

    const partnerRole = await this.prisma.projectPartnerRole.findFirst({
      where: {
        projectId,
        ...activePartnerRoleWhere(new Date()),
        party: { user: { id: { in: userIds } } },
      },
      select: { id: true },
    });
    return partnerRole != null;
  }

  /**
   * QA6 security review — may ANOTHER user (not the caller) open the
   * project? For deciding who gets a notification about one of its
   * tasks: an assignment no longer grants access, so an assignee may
   * well be outside it. Same rule as assertProjectAccess; Admin is
   * resolved from the user's roles (the attachMergedPermissions rule).
   * A missing or deleted project is `false`.
   */
  async userHasProjectAccess(userId: number, projectId: number): Promise<boolean> {
    try {
      await this.assertProjectMembership(userId, projectId, false, 'project');
      return true;
    } catch (err) {
      if (err instanceof NotFoundException) return false;
      if (!(err instanceof PermissionDeniedException)) throw err;
    }
    return this.isAdminUserId(userId);
  }

  /** Admin by role: granted roles (user_roles) win, else the legacy role. Inactive / deleted: no. */
  private async isAdminUserId(userId: number): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
      select: {
        role: { select: { name: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!user) return false;
    const granted = user.userRoles ?? [];
    return granted.length > 0 ? granted.some((ur) => ur.role?.name === 'Admin') : user.role?.name === 'Admin';
  }

  /**
   * QA6 — is the user on the project's Team: leader, creator, a
   * ProjectMember row or an active partner role (rules 2–4)? Org unit
   * (6) and manager chain (7) give access but do NOT put a person on
   * the Team. A missing or deleted project is `false`.
   */
  async isOnProjectTeam(userId: number, projectId: number): Promise<boolean> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { leaderId: true, createdBy: true },
    });
    if (!project) return false;
    if (project.leaderId === userId || project.createdBy === userId) return true;
    return this.anyUserOnProject([userId], projectId);
  }

  /**
   * Project ids where any of `userIds` is leader, creator, member or
   * active partner-role holder (rules 2–4).
   */
  private async projectIdsOfUsers(userIds: number[]): Promise<number[]> {
    if (userIds.length === 0) return [];
    const [memberships, led, partnerRoles] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { userId: { in: userIds } },
        select: { projectId: true },
      }),
      this.prisma.project.findMany({
        where: {
          OR: [{ leaderId: { in: userIds } }, { createdBy: { in: userIds } }],
          deletedAt: null,
        },
        select: { id: true },
      }),
      this.prisma.projectPartnerRole.findMany({
        where: { ...activePartnerRoleWhere(new Date()), party: { user: { id: { in: userIds } } } },
        select: { projectId: true },
      }),
    ]);
    const ids = new Set<number>();
    for (const m of memberships ?? []) ids.add(m.projectId);
    for (const p of led ?? []) ids.add(p.id);
    for (const r of partnerRoles ?? []) ids.add(r.projectId);
    return [...ids];
  }

  /**
   * Leader or Admin only (permissions round 4): changing the team
   * (members, partner roles), the leader, settings / edit, close /
   * reopen / archive, and delete. 404 when the project is missing or
   * soft-deleted; 403 NOT_PROJECT_LEADER otherwise.
   */
  async assertProjectManage(user: { id: number } & Record<string, any>, projectId: number): Promise<void> {
    if (this.adminBypass(isAdminUser(user))) return;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { leaderId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (user?.id != null && project.leaderId === user.id) return;
    throw notProjectLeader();
  }

  /**
   * QA6 — `assertProjectManage` as a boolean, for payloads that tell the
   * web whether to offer leader-only actions (GET /projects/:id
   * `canManage`). A missing project is still a 404.
   */
  async canManageProject(user: { id: number } & Record<string, any>, projectId: number): Promise<boolean> {
    try {
      await this.assertProjectManage(user, projectId);
      return true;
    } catch (err) {
      if (err instanceof PermissionDeniedException) return false;
      throw err;
    }
  }

  /**
   * Resolves a task → projectId then asserts access. Returns the
   * projectId, or null for personal tasks (Tier D #1) which are
   * accessible to their creator + assignees regardless of any project
   * membership. Callers that require a project-scoped id must guard
   * on the null case explicitly.
   */
  async assertTaskAccess(
    userId: number,
    taskId: number,
    isAdmin: boolean,
  ): Promise<number | null> {
    if (this.adminBypass(isAdmin)) {
      const t = await this.prisma.task.findFirst({
        where: { id: taskId, deletedAt: null },
        select: { projectId: true },
      });
      if (!t) throw new NotFoundException('Task not found');
      return t.projectId;
    }

    const task = await this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { projectId: true, createdBy: true, assignees: { where: { userId, deletedAt: null }, select: { id: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');

    // Personal task: access is via the task itself (creator or assignee).
    if (task.projectId == null) {
      const isOwner = task.createdBy === userId;
      const isAssigned = (task.assignees ?? []).length > 0;
      if (!isOwner && !isAssigned) {
        throw new PermissionDeniedException(
          'This is a personal task — only the person who created it and its assignees can open it.',
          { module: 'tasks', reason: 'PERSONAL_TASK' },
        );
      }
      return null;
    }

    await this.assertProjectMembership(userId, task.projectId, isAdmin, 'task');
    return task.projectId;
  }

  /**
   * Resolves a zone → projectId then asserts access. Returns the projectId.
   */
  async assertZoneAccess(
    userId: number,
    zoneId: number,
    isAdmin: boolean,
  ): Promise<number> {
    if (this.adminBypass(isAdmin)) {
      const z = await this.prisma.zone.findFirst({
        where: { id: zoneId, deletedAt: null },
        select: { projectId: true },
      });
      if (!z) throw new NotFoundException('Zone not found');
      return z.projectId;
    }

    const zone = await this.prisma.zone.findFirst({
      where: { id: zoneId, deletedAt: null },
      select: { projectId: true },
    });
    if (!zone) throw new NotFoundException('Zone not found');

    await this.assertProjectMembership(userId, zone.projectId, isAdmin, 'zone');
    return zone.projectId;
  }

  /**
   * Returns the set of project IDs the user can access under the same
   * rule as assertProjectAccess (rules 2–4, 6, 7). Admins get
   * `{ all: true, projectIds: [] }` (callers treat that as "all").
   * Used for filtering list endpoints.
   *
   * `analysis.withoutRule6` is for the read-only QA6 package-1ב impact
   * script (scripts/qa6-rule6-impact.ts) only: it answers "what would
   * this user see without the home-OrgUnit rule". No request path
   * passes it; rule 6 itself is unchanged.
   */
  async getAccessibleProjectIds(
    userId: number,
    isAdmin: boolean,
    analysis?: { withoutRule6?: boolean },
  ): Promise<{ all: boolean; projectIds: number[] }> {
    if (this.adminBypass(isAdmin)) return { all: true, projectIds: [] };

    // Rules 2–4 for the caller.
    const ids = new Set<number>(await this.projectIdsOfUsers([userId]));

    // Rule 6: projects of the caller's home OrgUnit.
    const caller = analysis?.withoutRule6
      ? null
      : await this.prisma.user.findUnique({
          where: { id: userId },
          select: { orgUnitId: true },
        });
    if (caller?.orgUnitId) {
      const unitProjects = await this.prisma.project.findMany({
        where: { orgUnitId: caller.orgUnitId, deletedAt: null },
        select: { id: true },
      });
      for (const p of unitProjects) ids.add(p.id);
    }

    // Rule 7: rules 2–4 for every subordinate in the managed subtree.
    const subs = await this.getSubordinateUserIds(userId);
    for (const id of await this.projectIdsOfUsers(subs)) ids.add(id);

    return { all: false, projectIds: [...ids] };
  }

  /**
   * Ids of every OrgUnit the user manages, EXPANDED to include the full
   * subtree of each. Uses the materialised `path` column on OrgUnit —
   * a descendant's path starts with its ancestor's path, so a single
   * `startsWith` query per managed unit resolves the entire subtree
   * without recursion. Duplicate ids across overlapping subtrees are
   * de-duped.
   *
   * Returns [] if the user manages nothing — the caller uses that as
   * the signal to short-circuit and preserve pre-feature behaviour.
   *
   * Round 3 (2026-11-22): a managed unit whose `path` was never written
   * ("/" — the column default — or empty) contributes only itself:
   * `startsWith('/')` would match every unit in the tree. Same guard as
   * EmployeeScopeService.currentSubordinateIds.
   */
  async getManagedSubtreeUnitIds(userId: number): Promise<number[]> {
    const managed = await this.prisma.orgUnit.findMany({
      where: { managerUserId: userId, deletedAt: null },
      select: { id: true, path: true },
    });
    if (managed.length === 0) return [];

    // A usable path names at least one unit id ("/1/5/"); normalise the
    // trailing "/" so "/1/5" can't match "/1/50/".
    const subtreePrefix = (path: string | null | undefined): string | null => {
      const ids = String(path ?? '')
        .split('/')
        .filter((s) => /^\d+$/.test(s) && Number(s) > 0);
      return ids.length > 0 ? `/${ids.join('/')}/` : null;
    };
    const prefixes = managed.map((u) => subtreePrefix(u.path)).filter((p): p is string => p != null);

    // Union of the managed units themselves and their subtrees.
    const subtreeUnits = await this.prisma.orgUnit.findMany({
      where: {
        deletedAt: null,
        OR: [
          { id: { in: managed.map((u) => u.id) } },
          ...prefixes.map((p) => ({ path: { startsWith: p } })),
        ],
      },
      select: { id: true },
    });
    return Array.from(new Set(subtreeUnits.map((u) => u.id)));
  }

  /**
   * User ids whose home OrgUnit sits inside any unit the given user
   * manages (per getManagedSubtreeUnitIds). Excludes the manager
   * themselves so a manager listed as their own subordinate doesn't
   * accidentally short-circuit self-checks upstream. Returns [] if
   * the manager has no managed subtree.
   *
   * Memoized per-instance keyed by userId. Callers invalidate via
   * invalidateSubordinateCache when the tree/assignments change (see
   * OrgUnitService).
   */
  async getSubordinateUserIds(userId: number): Promise<number[]> {
    const cached = this.subordinatesMemo.get(userId);
    if (cached) return cached;
    const promise = this.computeSubordinateUserIds(userId);
    this.subordinatesMemo.set(userId, promise);
    // If the underlying query rejects, evict so the next call retries
    // instead of caching the failure forever.
    promise.catch(() => this.subordinatesMemo.delete(userId));
    return promise;
  }

  private async computeSubordinateUserIds(userId: number): Promise<number[]> {
    const unitIds = await this.getManagedSubtreeUnitIds(userId);
    if (unitIds.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: {
        orgUnitId: { in: unitIds },
        deletedAt: null,
        id: { not: userId }, // exclude the manager themselves
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}
