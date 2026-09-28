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
}
