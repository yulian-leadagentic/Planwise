import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type OverrideAction = 'canRead' | 'canWrite' | 'canDelete';

export interface EffectivePermission {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
}

/**
 * Resolves per-resource permission overrides.
 *
 * Overrides can ONLY narrow — never widen — the default module-level
 * permission. The check order:
 *   1. Module-level (RoleModule) says canWrite = true
 *   2. If a ResourceOverride for this (type, id, role/user) exists
 *      with canWrite = false → the override wins, user loses write.
 *   3. If no override exists → use the module-level permission.
 *
 * An override with canRead = false effectively hides the resource.
 */
@Injectable()
export class ResourceOverrideService {
  constructor(private prisma: PrismaService) {}

  /**
   * Returns the effective permission for a specific resource, given the
   * user's module-level permission as a base. Returns the intersection:
   * base ∩ override (both must be true for the action to be allowed).
   */
  async getEffective(
    resourceType: string,
    resourceId: number,
    roleId: number | null,
    userId: number | null,
    modulePermission: EffectivePermission,
  ): Promise<EffectivePermission> {
    // Super-admin bypass
    if (roleId === 1) return modulePermission;

    // Find the most specific override: user > role > none
    const overrides = await this.prisma.resourceOverride.findMany({
      where: {
        resourceType,
        resourceId,
        OR: [
          ...(userId ? [{ userId }] : []),
          ...(roleId ? [{ roleId, userId: null }] : []),
        ],
      },
      orderBy: { id: 'asc' },
    });

    if (overrides.length === 0) return modulePermission;

    // User-level override takes precedence over role-level
    const userOverride = userId ? overrides.find((o) => o.userId === userId) : null;
    const roleOverride = roleId ? overrides.find((o) => o.roleId === roleId && o.userId === null) : null;
    const override = userOverride ?? roleOverride;

    if (!override) return modulePermission;

    // Intersection: override can only subtract
    return {
      canRead: modulePermission.canRead && override.canRead,
      canWrite: modulePermission.canWrite && override.canWrite,
      canDelete: modulePermission.canDelete && override.canDelete,
    };
  }

  /**
   * Checks if a specific action is allowed on a resource. Combines
   * module-level + override logic.
   */
  async can(
    resourceType: string,
    resourceId: number,
    roleId: number | null,
    userId: number | null,
    modulePermission: EffectivePermission,
    action: OverrideAction,
  ): Promise<boolean> {
    const eff = await this.getEffective(resourceType, resourceId, roleId, userId, modulePermission);
    return eff[action];
  }

  /**
   * Returns all overrides for a given resource. Used by admin UI.
   */
  async listOverrides(resourceType: string, resourceId: number) {
    return this.prisma.resourceOverride.findMany({
      where: { resourceType, resourceId },
      include: {
        role: { select: { id: true, name: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: [{ roleId: 'asc' }, { userId: 'asc' }],
    });
  }

  /**
   * Set/update an override for a resource + role (or user).
   */
  async setOverride(data: {
    resourceType: string;
    resourceId: number;
    roleId?: number | null;
    userId?: number | null;
    canRead: boolean;
    canWrite: boolean;
    canDelete: boolean;
  }) {
    const roleId = data.roleId ?? null;
    const userId = data.userId ?? null;

    return this.prisma.resourceOverride.upsert({
      where: {
        resourceType_resourceId_roleId_userId: {
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          roleId: roleId as any,
          userId: userId as any,
        },
      },
      create: {
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        roleId,
        userId,
        canRead: data.canRead,
        canWrite: data.canWrite,
        canDelete: data.canDelete,
      },
      update: {
        canRead: data.canRead,
        canWrite: data.canWrite,
        canDelete: data.canDelete,
      },
    });
  }

  /**
   * Remove an override — the resource reverts to module-level permission.
   */
  async removeOverride(id: number) {
    await this.prisma.resourceOverride.delete({ where: { id } });
    return { message: 'Override removed' };
  }

  /**
   * Remove ALL overrides for a resource.
   */
  async removeAllOverrides(resourceType: string, resourceId: number) {
    await this.prisma.resourceOverride.deleteMany({
      where: { resourceType, resourceId },
    });
    return { message: 'All overrides removed' };
  }
}
