import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessPartnersService } from '../business-partners/business-partners.service';

/**
 * People UX M6 (P-03) — read-only admin reports for home-org drift.
 *
 * Auto-fix is deliberately out of scope: the D1 employee rule now
 * classifies by user-email domain against the home org's owned
 * domains, so ANY drift (a user with a non-AMEC email listed as an
 * employee; a person BP on the home domain who has no login user) is
 * a data question, not a code question. The endpoint below surfaces
 * both drift buckets so an admin can fix them one at a time.
 *
 * Kept in the `admin` module so it's guarded by the same admin
 * permission as `/admin/config` — the report leaks user emails and
 * should never be public.
 */
@ApiTags('Admin - Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/reports')
export class ReportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bpService: BusinessPartnersService,
  ) {}

  /**
   * People UX M6 (P-03) — home-org drift report.
   *
   * Two independent lists (neither is auto-corrected):
   *
   *   • `offDomainEmployees` — Users whose BP row is NOT excluded by the
   *     `excludeInternal` filter (i.e. today's employee-facing screens
   *     treat them as employees) but whose email domain is not owned by
   *     the home org. Practically: someone we onboarded with a
   *     non-AMEC email address.
   *   • `onDomainWithoutUser` — Person BPs whose email sits on a domain
   *     the home org owns, but who have no attached login user. They
   *     should probably be promoted to employees, or moved off the
   *     domain, or the domain claim revisited.
   *
   * Response shape is stable across DB size — everything is either an
   * anti-join or a size-bounded existence check. When the home org is
   * missing altogether we return empty arrays with an `unresolvedHomeOrg`
   * flag so a future admin UI can surface "no home org configured" as a
   * distinct state instead of "everything is fine".
   */
  @Get('home-org-employees')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'Home-org drift report (D1 employee rule)' })
  async homeOrgEmployees() {
    const homeOrg = await this.bpService.getHomeOrg();
    if (!homeOrg) {
      return {
        unresolvedHomeOrg: true,
        homeOrgId: null,
        ownedDomains: [],
        offDomainEmployees: [],
        onDomainWithoutUser: [],
      };
    }

    const ownedDomains = (homeOrg.domains ?? [])
      .filter((d) => !d.isPersonal)
      .map((d) => d.domain.toLowerCase());

    // ── 1. Employees whose email is off-domain ─────────────────────────
    // An "employee" for the purpose of this report is anyone with a
    // User row (login account). The set of "employees on-domain" is
    // computed by the `endsWith '@<domain>'` filter; the OFF-domain
    // list is the anti-set. When no domains are owned yet we still
    // return every active user — they're all "off-domain" until the
    // catalog is filled in.
    const activeUsers = await this.prisma.user.findMany({
      where: { deletedAt: null, isActive: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    const offDomainEmployees = activeUsers
      .filter((u) => {
        const email = (u.email ?? '').toLowerCase();
        if (!email.includes('@')) return true; // no domain → off-domain
        return !ownedDomains.some((d) => email.endsWith(`@${d}`));
      })
      .map((u) => ({
        userId: u.id,
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || `#${u.id}`,
      }));

    // ── 2. Person BPs on-domain that have no attached user ─────────────
    // Only meaningful when at least one domain is owned. Uses `endsWith`
    // per domain; there are usually 1-3 domains so the OR is small.
    const onDomainWithoutUser =
      ownedDomains.length === 0
        ? []
        : (
            await this.prisma.businessPartner.findMany({
              where: {
                partnerType: 'person',
                deletedAt: null,
                user: { is: null },
                OR: ownedDomains.map((d) => ({
                  email: { endsWith: `@${d}` },
                })),
              },
              select: {
                id: true,
                displayName: true,
                email: true,
              },
              orderBy: { displayName: 'asc' },
            })
          ).map((bp) => ({
            bpId: bp.id,
            email: bp.email,
            name: bp.displayName,
          }));

    return {
      unresolvedHomeOrg: false,
      homeOrgId: homeOrg.id,
      ownedDomains,
      offDomainEmployees,
      onDomainWithoutUser,
    };
  }

  /**
   * Labor Category M17 — mismatch report between the User cache column
   * and the UserSeniority history that owns the truth. Two independent
   * lists so an admin can resolve each manually (no auto-fix — history
   * writes must be date-effective, and only a human knows the correct
   * effective-from):
   *
   *   • `cacheMismatches` — Users whose `user.seniorityLevelId` is not
   *     the same as the level on the currently-effective history row
   *     (as of today). Almost always caused by a pre-M17 direct
   *     `PATCH /users/:id { seniorityLevelId }` write that never made
   *     it into the history chain.
   *   • `categoryWithoutHistory` — Users with `user.seniorityLevelId`
   *     set but zero rows in `user_seniorities`. Same root cause; kept
   *     as its own bucket because the fix is "seed a history row with
   *     a sensible effective-from" rather than "reconcile which row is
   *     wrong".
   *
   * Response shape is bounded — one query per bucket. Route only; no
   * UI surface. Yulian resolves via the People edit modal's Labor
   * Category History section.
   */
  @Get('labor-category-mismatches')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'M17 — Users whose Labor Category cache disagrees with history' })
  async laborCategoryMismatches() {
    const today = new Date();

    // Pull every user that has a cached seniorityLevelId. The two
    // buckets are subsets of this set — no need to scan users without
    // any category.
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null, seniorityLevelId: { not: null } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        seniorityLevelId: true,
        seniorityLevel: { select: { id: true, code: true, name: true } },
      },
    });

    // Batch-load the history rows covering "today" for the same set —
    // one query per user would be O(N). We fetch all history for these
    // users and pick the current row in memory.
    const userIds = users.map((u) => u.id);
    const allHistory =
      userIds.length === 0
        ? []
        : await this.prisma.userSeniority.findMany({
            where: { userId: { in: userIds } },
            include: { seniorityLevel: { select: { id: true, code: true, name: true } } },
            orderBy: [{ userId: 'asc' }, { startDate: 'desc' }],
          });

    const historyByUser = new Map<number, typeof allHistory>();
    for (const row of allHistory) {
      const list = historyByUser.get(row.userId) ?? [];
      list.push(row);
      historyByUser.set(row.userId, list);
    }

    const cacheMismatches: Array<{
      userId: number;
      email: string | null;
      name: string;
      cachedLevel: { id: number; code: string; name: string } | null;
      currentHistoryLevel: { id: number; code: string; name: string } | null;
      effectiveFrom: string | null;
    }> = [];
    const categoryWithoutHistory: Array<{
      userId: number;
      email: string | null;
      name: string;
      cachedLevel: { id: number; code: string; name: string } | null;
    }> = [];

    for (const u of users) {
      const rows = historyByUser.get(u.id) ?? [];
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || `#${u.id}`;
      const cachedLevel = u.seniorityLevel
        ? { id: u.seniorityLevel.id, code: u.seniorityLevel.code, name: u.seniorityLevel.name }
        : null;

      if (rows.length === 0) {
        categoryWithoutHistory.push({
          userId: u.id,
          email: u.email,
          name,
          cachedLevel,
        });
        continue;
      }

      // Current row = the one whose [startDate, endDate] covers today.
      // Fall back to the newest startDate <= today when none is
      // currently open — matches the resolver's behavior.
      const current =
        rows.find((r) => r.startDate <= today && (r.endDate === null || r.endDate >= today)) ??
        rows.find((r) => r.startDate <= today) ??
        null;
      const currentLevelId = current?.seniorityLevelId ?? null;
      if (currentLevelId !== u.seniorityLevelId) {
        cacheMismatches.push({
          userId: u.id,
          email: u.email,
          name,
          cachedLevel,
          currentHistoryLevel: current?.seniorityLevel
            ? {
                id: current.seniorityLevel.id,
                code: current.seniorityLevel.code,
                name: current.seniorityLevel.name,
              }
            : null,
          effectiveFrom: current ? current.startDate.toISOString().slice(0, 10) : null,
        });
      }
    }

    return { cacheMismatches, categoryWithoutHistory };
  }
}
