import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Enforces per-role Kanban stage transition rules.
 *
 * Logic:
 * - If NO RoleStageTransition rows exist for a role, the role can
 *   perform ALL transitions (backward compatible — no config = no
 *   restrictions).
 * - Once ANY row exists for a role, ONLY the listed from→to pairs
 *   are allowed; everything else is blocked.
 * - Super-admin (roleId=1) always bypasses.
 */
@Injectable()
export class StageTransitionService {
  constructor(private prisma: PrismaService) {}

  /**
   * Throws ForbiddenException if the transition is not allowed for this
   * role. Returns silently if the transition is permitted.
   */
  async assertTransition(
    roleId: number | null | undefined,
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    if (fromStatus === toStatus) return;
    if (roleId === 1) return; // super-admin

    if (!roleId) {
      throw new ForbiddenException('Role required to change task status');
    }

    // Check if any transitions are configured for this role
    const count = await this.prisma.roleStageTransition.count({
      where: { roleId },
    });

    // No config = unrestricted (backward compatible)
    if (count === 0) return;

    // Config exists — check for the specific transition
    const allowed = await this.prisma.roleStageTransition.findUnique({
      where: {
        roleId_fromStatus_toStatus: { roleId, fromStatus, toStatus },
      },
    });

    if (!allowed) {
      throw new ForbiddenException(
        `Your role cannot move tasks from "${fromStatus}" to "${toStatus}"`,
      );
    }
  }

  /**
   * Returns the list of statuses a role can transition TO from a given
   * status. Used by the frontend to show/hide options.
   * Returns null = "all transitions allowed" (no config for this role).
   */
  async getAllowedTargets(
    roleId: number,
    fromStatus: string,
  ): Promise<string[] | null> {
    if (roleId === 1) return null; // super-admin: all

    const count = await this.prisma.roleStageTransition.count({
      where: { roleId },
    });
    if (count === 0) return null; // no config = all

    const rows = await this.prisma.roleStageTransition.findMany({
      where: { roleId, fromStatus },
      select: { toStatus: true },
    });

    return rows.map((r) => r.toStatus);
  }

  /**
   * Returns the full transition matrix for a role: { fromStatus → toStatus[] }.
   * Used by the Admin UI.
   */
  async getMatrix(roleId: number): Promise<Record<string, string[]>> {
    const rows = await this.prisma.roleStageTransition.findMany({
      where: { roleId },
      orderBy: [{ fromStatus: 'asc' }, { toStatus: 'asc' }],
    });

    const matrix: Record<string, string[]> = {};
    for (const row of rows) {
      if (!matrix[row.fromStatus]) matrix[row.fromStatus] = [];
      matrix[row.fromStatus].push(row.toStatus);
    }
    return matrix;
  }

  /**
   * Replaces the entire transition matrix for a role.
   * Accepts an array of { from, to } pairs.
   */
  async setMatrix(
    roleId: number,
    transitions: { from: string; to: string }[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.roleStageTransition.deleteMany({ where: { roleId } }),
      ...transitions.map((t) =>
        this.prisma.roleStageTransition.create({
          data: { roleId, fromStatus: t.from, toStatus: t.to },
        }),
      ),
    ]);
  }
}
