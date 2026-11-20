import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isAdminUser } from '../guards/roles.guard';
import { PermissionDeniedException } from '../errors/permission-denied';

/** Board column names as the web shows them (apps/web/src/lib/task-constants.ts STATUS_LABEL). */
const STATUS_LABELS: Record<string, string> = {
  not_started: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  completed: 'Done',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

/**
 * Enforces per-role Kanban stage transition rules.
 *
 * Logic:
 * - If NO RoleStageTransition rows exist for a role, the role can
 *   perform ALL transitions (backward compatible — no config = no
 *   restrictions).
 * - Once ANY row exists for a role, ONLY the listed from→to pairs
 *   are allowed; everything else is blocked.
 * - Admins (`isAdminUser`, the RolesGuard's multi-role definition)
 *   always bypass. Permissions round 1 (2026-11-20) replaced the legacy
 *   `roleId === 1` check; the per-role rows still key on the user's
 *   legacy `roleId`.
 */
@Injectable()
export class StageTransitionService {
  constructor(private prisma: PrismaService) {}

  /**
   * Throws ForbiddenException if the transition is not allowed for this
   * role. Returns silently if the transition is permitted.
   */
  async assertTransition(
    user: { roleId?: number | null } | null | undefined,
    fromStatus: string,
    toStatus: string,
  ): Promise<void> {
    if (fromStatus === toStatus) return;
    if (isAdminUser(user)) return;
    const roleId = user?.roleId;

    if (!roleId) {
      throw new PermissionDeniedException(
        "Your account has no access role, so you can't change task status. Ask your administrator.",
        { module: 'tasks', reason: 'NO_ROLE' },
      );
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
      throw new PermissionDeniedException(
        `Your access role can't move a task from "${statusLabel(fromStatus)}" to "${statusLabel(toStatus)}". Ask your administrator.`,
        { module: 'tasks', reason: 'STAGE_TRANSITION' },
      );
    }
  }

  /**
   * Returns the list of statuses a role can transition TO from a given
   * status. Used by the frontend to show/hide options.
   * Returns null = "all transitions allowed" (no config for this role).
   */
  async getAllowedTargets(
    user: { roleId?: number | null } | null | undefined,
    fromStatus: string,
  ): Promise<string[] | null> {
    if (isAdminUser(user)) return null; // admin: all
    const roleId = user?.roleId;
    if (!roleId) return null;

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
