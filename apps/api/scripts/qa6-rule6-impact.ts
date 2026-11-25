/**
 * QA6 package 1ב (PR-065) — READ-ONLY impact report for ProjectAccessService
 * rule 6 ("projects of the caller's home OrgUnit").
 *
 *   # from apps/api/ (self-loads .env):
 *   node -r ts-node/register scripts/qa6-rule6-impact.ts 101 102 103
 *   node -r ts-node/register scripts/qa6-rule6-impact.ts --users=101,102,103 [--json]
 *
 * For every given user id it prints how many projects he can access
 * today, and how many he would access with rule 6 removed (everything
 * else unchanged: leader / creator, member, Team role, manager chain).
 *
 * It does not copy the rule: both counts come from
 * `ProjectAccessService.getAccessibleProjectIds`, the second with the
 * analysis-only `{ withoutRule6: true }` option. The Prisma client gets
 * the app's soft-delete middleware, as PrismaService does.
 *
 * This script never writes. Rule 6 itself is NOT changed: the decision
 * waits for the owner (qa6-fix-instructions.md › חבילה 1ב).
 */

// ─── Inline .env loader (same as p1-migrate-copies-to-refs.dry-run.ts) ──────
import * as fs from 'fs';
import * as path from 'path';
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {
  /* .env missing — Prisma will error if DATABASE_URL is unset */
}

import { PrismaClient } from '@prisma/client';

import { ProjectAccessService } from '../src/common/services/project-access.service';
import { applySoftDeleteMiddleware } from '../src/prisma/prisma.middleware';

function parseUserIds(argv: string[]): number[] {
  const raw = argv
    .filter((a) => a !== '--json')
    .flatMap((a) => (a.startsWith('--users=') ? a.slice('--users='.length) : a).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = raw.map(Number);
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error('Usage: qa6-rule6-impact.ts <userId> [<userId> ...]  (or --users=1,2,3) [--json]');
  }
  return [...new Set(ids)];
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const userIds = parseUserIds(argv);

  const prisma = new PrismaClient();
  applySoftDeleteMiddleware(prisma);
  // ProjectAccessService only uses the PrismaClient surface of PrismaService.
  const access = new ProjectAccessService(prisma as any);

  try {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        isActive: true,
        role: { select: { name: true } },
        userRoles: { select: { role: { select: { name: true } } } },
        orgUnit: { select: { id: true, name: true } },
      },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const rows: Array<Record<string, unknown>> = [];
    for (const id of userIds) {
      const u = byId.get(id);
      if (!u) {
        rows.push({ userId: id, error: 'user not found (or deleted)' });
        continue;
      }
      // Same admin definition as attachMergedPermissions / isAdminUser.
      const isAdmin =
        u.userRoles.length > 0 ? u.userRoles.some((r) => r.role.name === 'Admin') : u.role?.name === 'Admin';
      const managedUnits = await access.getManagedSubtreeUnitIds(id);
      const today = await access.getAccessibleProjectIds(id, isAdmin);
      const withoutRule6 = await access.getAccessibleProjectIds(id, isAdmin, { withoutRule6: true });
      const lost = today.all ? [] : today.projectIds.filter((p) => !withoutRule6.projectIds.includes(p));
      rows.push({
        userId: id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        active: u.isActive,
        accessRole: u.userRoles.map((r) => r.role.name).join(', ') || u.role?.name || null,
        homeOrgUnit: u.orgUnit ? `${u.orgUnit.name} (#${u.orgUnit.id})` : null,
        managesUnits: managedUnits.length,
        projectsToday: today.all ? 'ALL (Admin)' : today.projectIds.length,
        projectsWithoutRule6: withoutRule6.all ? 'ALL (Admin)' : withoutRule6.projectIds.length,
        wouldLose: lost.length,
        lostProjectIds: lost.sort((a, b) => a - b),
      });
    }

    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.table(
        rows.map(({ lostProjectIds: _ids, ...r }) => r),
      );
      for (const r of rows) {
        const ids = r.lostProjectIds as number[] | undefined;
        if (ids && ids.length > 0) console.log(`user ${r.userId} would lose projects: ${ids.join(', ')}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
