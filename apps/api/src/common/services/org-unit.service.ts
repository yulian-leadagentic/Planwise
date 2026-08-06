import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from './project-access.service';
import type { Prisma } from '@prisma/client';

/**
 * OrgUnitService — structural CRUD for the single-parent org tree.
 *
 * The public surface is deliberately narrow (create / move / setManager /
 * assignUser) because ProjectAccessService only needs the tree to answer
 * two questions:
 *   1. Which units does this user manage (including full subtrees)?
 *   2. Which users have their home unit inside those subtrees?
 *
 * Path invariant
 * --------------
 *   path = (parent ? parent.path : "/") + id + "/"
 *   depth = parent ? parent.depth + 1 : 0
 *
 * A leading and trailing slash keeps `startsWith` subtree queries
 * unambiguous — "/1/12/" is a descendant of "/1/" but not of "/12/".
 * `depth` is derivable from `path` (slash count − 1) but stored to
 * avoid a string parse on every read.
 *
 * On move, both fields have to be recomputed for the WHOLE subtree,
 * not just the moved unit — every descendant's path prefix changes.
 * We do that in a single transaction so nobody sees a half-migrated
 * tree.
 *
 * Cycle protection
 * ----------------
 * A new parent must not be the unit itself or one of its descendants.
 * We detect that by comparing the candidate parent's path with the
 * moved unit's path — a descendant's path starts with the moved
 * unit's path.
 *
 * No HTTP surface here yet — this is the foundation for later admin
 * endpoints. Nothing calls it in production paths today, so introducing
 * this service is 100% additive.
 */
@Injectable()
export class OrgUnitService {
  constructor(
    private prisma: PrismaService,
    private projectAccess: ProjectAccessService,
  ) {}

  /**
   * Create a new unit. `parentId` places it under an existing unit; omit
   * for a root. `managerUserId` optionally seats a manager at creation
   * time; leave undefined to seat later via setManager.
   *
   * Two-step insert (create → update) because the correct `path` for
   * the new row depends on the row's own auto-increment id, which we
   * don't know until after the insert. Wrapped in a transaction so the
   * unit is never observable with the placeholder "/" path.
   */
  async create(input: {
    name: string;
    parentId?: number | null;
    managerUserId?: number | null;
    code?: string | null;
    sortOrder?: number;
  }) {
    const { name, parentId = null, managerUserId = null, code = null, sortOrder = 0 } = input;

    return this.prisma.$transaction(async (tx) => {
      let parentPath = '/';
      let parentDepth = -1; // so a root ends up with depth 0
      if (parentId != null) {
        const parent = await tx.orgUnit.findFirst({
          where: { id: parentId, deletedAt: null },
          select: { path: true, depth: true },
        });
        if (!parent) throw new NotFoundException(`Parent org unit ${parentId} not found`);
        parentPath = parent.path;
        parentDepth = parent.depth;
      }

      // Insert with placeholder path; get the id.
      const created = await tx.orgUnit.create({
        data: {
          name,
          code,
          parentId,
          managerUserId,
          sortOrder,
          path: '/', // rewritten immediately below
          depth: parentDepth + 1,
        },
      });

      // Rewrite the path now that we have an id.
      const fullPath = `${parentPath}${created.id}/`;
      return tx.orgUnit.update({
        where: { id: created.id },
        data: { path: fullPath },
      });
    });
  }

  /**
   * Move a unit under a new parent (or to the root, via newParentId=null).
   * Recomputes path + depth for the moved unit AND every descendant, in
   * one transaction, using the same materialised-path invariant as
   * create().
   *
   * Rejects any move that would form a cycle:
   *   - moving onto itself (newParentId === id)
   *   - moving under one of its own descendants (descendant.path starts
   *     with the moved unit's old path)
   */
  async move(id: number, newParentId: number | null) {
    if (newParentId === id) {
      throw new BadRequestException('A unit cannot be its own parent');
    }

    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.orgUnit.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, path: true, depth: true, parentId: true },
      });
      if (!unit) throw new NotFoundException(`Org unit ${id} not found`);

      let newParentPath = '/';
      let newParentDepth = -1;
      if (newParentId != null) {
        const parent = await tx.orgUnit.findFirst({
          where: { id: newParentId, deletedAt: null },
          select: { path: true, depth: true },
        });
        if (!parent) throw new NotFoundException(`New parent org unit ${newParentId} not found`);
        // Cycle guard: the new parent must not be a descendant of the
        // moved unit. Descendants' paths start with the moved unit's
        // path.
        if (parent.path.startsWith(unit.path)) {
          throw new BadRequestException('A unit cannot be moved under one of its own descendants');
        }
        newParentPath = parent.path;
        newParentDepth = parent.depth;
      }

      const oldPath = unit.path;
      const newSelfPath = `${newParentPath}${id}/`;
      const depthDelta = newParentDepth + 1 - unit.depth;

      // Pull the whole subtree (moved unit + descendants). Small
      // realistic tenants keep this list bounded; if this ever grows we
      // can switch to a raw UPDATE ... WHERE path LIKE '?%'.
      const subtree = await tx.orgUnit.findMany({
        where: { path: { startsWith: oldPath }, deletedAt: null },
        select: { id: true, path: true, depth: true },
      });

      for (const row of subtree) {
        const rewritten = newSelfPath + row.path.slice(oldPath.length);
        await tx.orgUnit.update({
          where: { id: row.id },
          data: {
            path: rewritten,
            depth: row.depth + depthDelta,
            // The moved unit itself gets its parentId updated; its
            // descendants keep whatever parent they had (inside the
            // subtree).
            ...(row.id === id ? { parentId: newParentId } : {}),
          },
        });
      }

      const moved = await tx.orgUnit.findUnique({ where: { id } });
      // A move can change which subtree ANY manager sees (both the
      // moved unit's old-parent chain and its new-parent chain shift).
      // Cheapest correct answer: wipe the whole cache.
      this.projectAccess.invalidateSubordinateCache();
      return moved;
    });
  }

  /**
   * Set (or clear) the manager for a unit. Null clears the field.
   * The manager field is nullable + SetNull on User delete, so setting
   * to null here is idempotent and safe.
   */
  async setManager(id: number, userId: number | null) {
    const unit = await this.prisma.orgUnit.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!unit) throw new NotFoundException(`Org unit ${id} not found`);

    if (userId != null) {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      });
      if (!user) throw new NotFoundException(`User ${userId} not found`);
    }

    const updated = await this.prisma.orgUnit.update({
      where: { id },
      data: { managerUserId: userId },
    });
    // A manager change flips subordinate-set membership for BOTH the
    // old and the new manager; we don't know the old one cheaply, so
    // wipe the whole cache.
    this.projectAccess.invalidateSubordinateCache();
    return updated;
  }

  /**
   * Set (or clear) a user's home unit. Null unlinks the user from any
   * unit — they revert to the pre-org-access "no subordinate" state and
   * ProjectAccessService continues to treat them exactly as it does
   * today.
   */
  async assignUser(userId: number, unitId: number | null) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    if (unitId != null) {
      const unit = await this.prisma.orgUnit.findFirst({
        where: { id: unitId, deletedAt: null },
        select: { id: true },
      });
      if (!unit) throw new NotFoundException(`Org unit ${unitId} not found`);
    }

    // The Prisma User model owns the FK, so update through the user.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { orgUnitId: unitId } as Prisma.UserUpdateInput,
      select: { id: true, orgUnitId: true },
    });
    // The affected manager set is "whoever manages any unit in the
    // subtree that contains unitId, plus whoever managed the subtree
    // that contained the user's OLD home unit". Cheap correct move:
    // wipe the whole cache.
    this.projectAccess.invalidateSubordinateCache();
    return updated;
  }
}
