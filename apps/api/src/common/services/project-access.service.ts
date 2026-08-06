import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Centralizes project-scoped authorization. Use this in any service that
 * accepts a project/zone/task ID from a request to make sure the caller
 * is actually a member of that project (or a super-admin).
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
   * Returns true for super-admins (roleId === 1) — they can see everything.
   */
  private isSuperAdmin(roleId?: number | null): boolean {
    return roleId === 1;
  }

  /**
   * Throws ForbiddenException if `userId` is not a member of `projectId`
   * and is not a super-admin. Throws NotFoundException if the project
   * does not exist (or is soft-deleted).
   *
   * If direct membership fails, before throwing we widen the check to
   * hierarchical access: if any of the caller's subordinates (from
   * their managed org-unit subtree) is a member of / leader of /
   * creator of the project, the caller is allowed. Callers with no
   * managed units get an empty subordinate set → identical rejection
   * behaviour to the pre-feature version.
   */
  async assertProjectAccess(
    userId: number,
    projectId: number,
    roleId?: number | null,
  ): Promise<void> {
    if (this.isSuperAdmin(roleId)) return;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, leaderId: true, createdBy: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (project.leaderId === userId || project.createdBy === userId) return;

    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      select: { id: true },
    });
    if (membership) return;

    // Hierarchical fallback — a manager whose subordinate touches the
    // project (as member / leader / creator) inherits access.
    const subs = await this.getSubordinateUserIds(userId);
    if (subs.length > 0) {
      if (project.leaderId != null && subs.includes(project.leaderId)) return;
      if (project.createdBy != null && subs.includes(project.createdBy)) return;
      const subMembership = await this.prisma.projectMember.findFirst({
        where: { projectId, userId: { in: subs } },
        select: { id: true },
      });
      if (subMembership) return;
    }

    throw new ForbiddenException('You do not have access to this project');
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
    roleId?: number | null,
  ): Promise<number | null> {
    if (this.isSuperAdmin(roleId)) {
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
        throw new ForbiddenException('You do not have access to this task');
      }
      return null;
    }

    await this.assertProjectAccess(userId, task.projectId, roleId);
    return task.projectId;
  }

  /**
   * Resolves a zone → projectId then asserts access. Returns the projectId.
   */
  async assertZoneAccess(
    userId: number,
    zoneId: number,
    roleId?: number | null,
  ): Promise<number> {
    if (this.isSuperAdmin(roleId)) {
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

    await this.assertProjectAccess(userId, zone.projectId, roleId);
    return zone.projectId;
  }

  /**
   * Returns the set of project IDs the user can access. Super-admins
   * get an empty set (callers should treat empty + super-admin as "all").
   * Used for filtering list endpoints (e.g. execution-board).
   *
   * Extended for hierarchical access: after the direct member/led
   * union, if the user manages any subordinates, add every project
   * they touch (member of, or leader/creator of). Empty subordinate
   * set (no org-tree involvement) skips the widen step entirely —
   * bit-for-bit identical to the pre-feature behaviour.
   */
  async getAccessibleProjectIds(
    userId: number,
    roleId?: number | null,
  ): Promise<{ all: boolean; projectIds: number[] }> {
    if (this.isSuperAdmin(roleId)) return { all: true, projectIds: [] };

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const led = await this.prisma.project.findMany({
      where: { OR: [{ leaderId: userId }, { createdBy: userId }], deletedAt: null },
      select: { id: true },
    });
    const ids = new Set<number>();
    for (const m of memberships) ids.add(m.projectId);
    for (const p of led) ids.add(p.id);

    // Hierarchical widen.
    const subs = await this.getSubordinateUserIds(userId);
    if (subs.length > 0) {
      const subMemberships = await this.prisma.projectMember.findMany({
        where: { userId: { in: subs } },
        select: { projectId: true },
      });
      const subLed = await this.prisma.project.findMany({
        where: {
          OR: [
            { leaderId: { in: subs } },
            { createdBy: { in: subs } },
          ],
          deletedAt: null,
        },
        select: { id: true },
      });
      for (const m of subMemberships) ids.add(m.projectId);
      for (const p of subLed) ids.add(p.id);
    }

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
   */
  async getManagedSubtreeUnitIds(userId: number): Promise<number[]> {
    const managed = await this.prisma.orgUnit.findMany({
      where: { managerUserId: userId, deletedAt: null },
      select: { path: true },
    });
    if (managed.length === 0) return [];

    // Union of subtrees. Use an OR on `path startsWith managed.path`.
    const subtreeUnits = await this.prisma.orgUnit.findMany({
      where: {
        deletedAt: null,
        OR: managed.map((u) => ({ path: { startsWith: u.path } })),
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
