import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';

/**
 * QA6 P7 (PR-056, owner's decision 25.11) — grant `operations:read` to
 * the roles that run Operations.
 *
 * Roles are matched by EXACT name (case and spelling as they are on
 * staging, typo included): Admin, "Depatment lead", "BIM leader".
 * Admin passes the RolesGuard bypass anyway; its explicit row makes the
 * Admin › Roles matrix tell the truth. Professonal / Employee get
 * nothing.
 *
 * Per matched role:
 *   • no row for the module            → create { canRead: true } (other flags off)
 *   • a row with canRead = false       → set canRead = true (other flags kept)
 *   • a row with canRead = true        → nothing ("already")
 * Idempotent: a second real run changes 0 rows. The module row itself
 * comes from migration 20261125180000_operations_module; if it is
 * missing the run creates it (the dry-run says so).
 */
export const OPERATIONS_MODULE = { name: 'Operations', route: '/operations', icon: 'Activity', sortOrder: 11 } as const;
export const QA6_OPERATIONS_ROLE_NAMES = ['Admin', 'Depatment lead', 'BIM leader'] as const;

export type Qa6OperationsGrantAction = 'create' | 'enable-read' | 'already';

export interface Qa6OperationsGrantsResult {
  dryRun: boolean;
  module: { id: number | null; name: string; route: string; created: boolean; missing: boolean };
  roles: Array<{ roleId: number; roleName: string; action: Qa6OperationsGrantAction }>;
  notFound: string[];
  /** Rows created or switched on (would be, on a dry-run). 0 on a repeat run. */
  granted: number;
}

/** Body `{ dryRun?: boolean }` — only the boolean `false` writes (abac635 convention). */
export function parseQa6OperationsGrantsBody(body: unknown): { dryRun: boolean } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return { dryRun: raw.dryRun !== false };
}

@Injectable()
export class Qa6OperationsGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async run({ dryRun, actorId }: { dryRun: boolean; actorId?: number | null }): Promise<Qa6OperationsGrantsResult> {
    const mod = await this.prisma.module.findFirst({
      where: { OR: [{ route: OPERATIONS_MODULE.route }, { route: 'operations' }, { name: OPERATIONS_MODULE.name }] },
      select: { id: true, name: true, route: true },
    });

    // MySQL compares names case-insensitively — keep only exact matches.
    const candidates = await this.prisma.role.findMany({
      where: { name: { in: [...QA6_OPERATIONS_ROLE_NAMES] } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    const roles = candidates.filter((r) => (QA6_OPERATIONS_ROLE_NAMES as readonly string[]).includes(r.name));
    const notFound = QA6_OPERATIONS_ROLE_NAMES.filter((n) => !roles.some((r) => r.name === n));

    const existing = mod
      ? await this.prisma.roleModule.findMany({
          where: { moduleId: mod.id, roleId: { in: roles.map((r) => r.id) } },
          select: { id: true, roleId: true, canRead: true },
        })
      : [];
    const plan = roles.map((r) => {
      const rows = existing.filter((e) => e.roleId === r.id);
      const action: Qa6OperationsGrantAction =
        rows.length === 0 ? 'create' : rows.some((e) => e.canRead) ? 'already' : 'enable-read';
      return { roleId: r.id, roleName: r.name, action, rowIds: rows.map((e) => e.id) };
    });
    const granted = plan.filter((p) => p.action !== 'already').length;

    const result = (moduleId: number | null, created: boolean): Qa6OperationsGrantsResult => ({
      dryRun,
      module: { id: moduleId, name: OPERATIONS_MODULE.name, route: mod?.route ?? OPERATIONS_MODULE.route, created, missing: !mod },
      roles: plan.map(({ roleId, roleName, action }) => ({ roleId, roleName, action })),
      notFound,
      granted,
    });

    if (dryRun) return result(mod?.id ?? null, false);

    let moduleId = mod?.id ?? null;
    let created = false;
    await this.prisma.$transaction(async (tx) => {
      if (moduleId == null) {
        const m = await tx.module.create({
          data: { name: OPERATIONS_MODULE.name, route: OPERATIONS_MODULE.route, icon: OPERATIONS_MODULE.icon, sortOrder: OPERATIONS_MODULE.sortOrder },
          select: { id: true },
        });
        moduleId = m.id;
        created = true;
      }
      for (const p of plan) {
        if (p.action === 'create') {
          await tx.roleModule.create({
            data: { roleId: p.roleId, moduleId: moduleId!, canRead: true, canWrite: false, canDelete: false, canApprove: false, canExport: false },
          });
        } else if (p.action === 'enable-read') {
          await tx.roleModule.updateMany({ where: { id: { in: p.rowIds } }, data: { canRead: true } });
        }
      }
    });

    // Same security trail as a grant made in Admin › Roles.
    for (const p of plan) {
      if (p.action === 'already') continue;
      await this.activityLog.logSecurityEvent({
        action: p.action === 'create' ? 'role.module_grant' : 'role.module_change',
        description: `Granted ${OPERATIONS_MODULE.route} read on role "${p.roleName}" (backfill qa6-operations-grants)`,
        actorUserId: actorId ?? null,
        entityType: 'role',
        entityId: p.roleId,
        entityName: p.roleName,
        changes: { module: { id: moduleId, route: OPERATIONS_MODULE.route, name: OPERATIONS_MODULE.name }, permissions: { canRead: true } },
        metadata: { backfill: 'qa6-operations-grants' },
      });
    }

    return result(moduleId, created);
  }
}
