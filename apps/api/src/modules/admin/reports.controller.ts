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

  // ─────────────────────────────────────────────────────────────────
  // People-model-alignment §9 — Phase 4 pre-migration verification
  // reports. Four independent GETs, one per stage in
  // `docs/bm2/people-model-alignment.md`. Every one of these is a
  // read-only anti-join / groupBy; NONE writes, migrates, or nudges
  // the schema. Yulian reviews each list before approving the
  // matching migration commit.
  //
  // Design choices shared by all four:
  //   • Return _both_ the reference set (e.g. every distinct department
  //     string) and the matching lookup so the UI can render "12 →
  //     matched to OrgUnit X" or "12 → no match". Yulian resolves the
  //     unmatched rows first.
  //   • Case-insensitive trim match — the free-text side is user-typed
  //     ("Design", " design ", "DESIGN") but the catalog is canonical.
  //   • Include EVERY bucket (matched + unmatched) so a downstream
  //     migration script cannot claim "0 unmatched" from a filtered
  //     list — the whole point of §9 is transparency.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Stage 1 — userType vs. home-domain drift.
   *
   * Two independent buckets, computed strictly in memory after two
   * bounded queries (users + BP domains):
   *   • `employeesOffHomeDomain` — `userType === 'employee'` whose
   *     email is NOT on a home-org owned domain. Under D1 these should
   *     stop being employees after the migration flips.
   *   • `onHomeDomainNotEmployee` — anyone on a home-org domain whose
   *     `userType` is not 'employee' (partner/both). D1 will promote
   *     them to Employee on the flip.
   *
   * Both lists include soft-deleted-out users only via `deletedAt = null`;
   * `isActive` rides along so the UI can visually deprioritize the
   * inactive rows without hiding them (an inactive user who is still
   * an "employee" record is exactly what §9 wants surfaced).
   */
  @Get('model-alignment/stage-1-usertype-vs-domain')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'Phase 4 Stage 1 — userType vs. home-domain drift' })
  async modelAlignmentStage1() {
    const homeOrg = await this.bpService.getHomeOrg();
    const homeDomains = (homeOrg?.domains ?? [])
      .filter((d) => !d.isPersonal)
      .map((d) => d.domain.toLowerCase());

    // One scan of Users, split into buckets in memory. Cheap; the row
    // count is small (dozens–hundreds).
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        userType: true,
        seniorityLevelId: true,
        isActive: true,
      },
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    });

    const domainOf = (email: string | null | undefined): string | null => {
      if (!email) return null;
      const at = email.lastIndexOf('@');
      if (at === -1) return null;
      return email.slice(at + 1).toLowerCase();
    };
    const isOnHomeDomain = (email: string | null | undefined) => {
      const d = domainOf(email);
      return d != null && homeDomains.includes(d);
    };

    const employeesOffHomeDomain: Array<{
      userId: number;
      email: string | null;
      name: string;
      userType: string;
      seniorityLevelId: number | null;
      isActive: boolean;
    }> = [];
    const onHomeDomainNotEmployee: Array<{
      userId: number;
      email: string | null;
      name: string;
      userType: string;
    }> = [];

    for (const u of users) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || `#${u.id}`;
      if (u.userType === 'employee' && !isOnHomeDomain(u.email)) {
        employeesOffHomeDomain.push({
          userId: u.id,
          email: u.email,
          name,
          userType: u.userType,
          seniorityLevelId: u.seniorityLevelId,
          isActive: u.isActive,
        });
      }
      if (u.userType !== 'employee' && isOnHomeDomain(u.email)) {
        onHomeDomainNotEmployee.push({
          userId: u.id,
          email: u.email,
          name,
          userType: u.userType,
        });
      }
    }

    return {
      homeOrgId: homeOrg?.id ?? null,
      homeDomains,
      employeesOffHomeDomain,
      onHomeDomainNotEmployee,
    };
  }

  /**
   * Stage 2 — Department → OrgUnit mapping preview.
   *
   * Two independent groupings, each carrying the best-effort OrgUnit
   * match. The match is case-insensitive on the trimmed unit name so a
   * "Design" ⇔ " Design " ⇔ "DESIGN" trio still maps to the same node.
   *   • `userDepartments` — every distinct `User.department` string
   *     (excluding null/empty) with a per-string user count. Null /
   *     empty is not a "mapping problem", it's a "no home unit yet"
   *     problem and belongs to a different stage.
   *   • `projectDepartments` — every `Project.departmentId` in use,
   *     hydrated with the `departments.name` value and the OrgUnit
   *     match. Projects with no `departmentId` are dropped; the
   *     mapping migration only cares about the referenced rows.
   *
   * OrgUnits filtered by `deletedAt = null` — a soft-deleted node is
   * not a valid target for the Stage 2 backfill.
   */
  @Get('model-alignment/stage-2-department-mapping')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'Phase 4 Stage 2 — Department → OrgUnit mapping preview' })
  async modelAlignmentStage2() {
    // Lookup table keyed by lower-trimmed name → OrgUnit.
    const orgUnits = await this.prisma.orgUnit.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
    });
    const unitByNameLc = new Map<string, { id: number; name: string }>();
    for (const u of orgUnits) {
      const key = (u.name ?? '').trim().toLowerCase();
      if (key && !unitByNameLc.has(key)) unitByNameLc.set(key, { id: u.id, name: u.name });
    }

    // — 1. User.department strings —
    // groupBy on the (nullable) column; drop the null bucket for the
    // mapping report.
    const userDeptGroups = await this.prisma.user.groupBy({
      by: ['department'],
      where: { deletedAt: null, department: { not: null } },
      _count: { _all: true },
    });
    const userDepartments = userDeptGroups
      .filter((g) => (g.department ?? '').trim() !== '')
      .map((g) => {
        const dept = g.department as string;
        const match = unitByNameLc.get(dept.trim().toLowerCase()) ?? null;
        return {
          department: dept,
          userCount: g._count._all,
          matchingOrgUnitId: match?.id ?? null,
          matchingOrgUnitName: match?.name ?? null,
        };
      })
      .sort((a, b) => b.userCount - a.userCount);

    // — 2. Project.departmentId values —
    const projDeptGroups = await this.prisma.project.groupBy({
      by: ['departmentId'],
      where: { departmentId: { not: null } },
      _count: { _all: true },
    });
    const deptIds = projDeptGroups
      .map((g) => g.departmentId)
      .filter((x): x is number => x != null);
    const deptRows = deptIds.length
      ? await this.prisma.department.findMany({
          where: { id: { in: deptIds } },
          select: { id: true, name: true },
        })
      : [];
    const deptById = new Map(deptRows.map((d) => [d.id, d.name] as const));
    const projectDepartments = projDeptGroups
      .map((g) => {
        const id = g.departmentId as number;
        const name = deptById.get(id) ?? null;
        const key = (name ?? '').trim().toLowerCase();
        const match = key ? unitByNameLc.get(key) ?? null : null;
        return {
          departmentId: id,
          departmentName: name,
          projectCount: g._count._all,
          matchingOrgUnitId: match?.id ?? null,
        };
      })
      .sort((a, b) => b.projectCount - a.projectCount);

    return { userDepartments, projectDepartments };
  }

  /**
   * Stage 3 — Contract.partnerId (User) → BusinessPartner resolution.
   *
   * One scan of Contract, each row hydrated with `partner → User` and
   * that user's `businessPartnerId`. Two buckets, and the second is a
   * strict subset of the first (a row is in `contractsWithoutPartnerBp`
   * iff its partner-User has no attached BP — the exact case Yulian
   * has to resolve before the Stage 3 migration).
   *
   * Uses `contract.name` in place of a `contractCode` field (the
   * Contract table has no `code` column at time of writing); the
   * response shape's field name is kept for future compatibility.
   * Rows where the partner-User is soft-deleted still appear — a
   * dangling FK is a real data point for the report.
   */
  @Get('model-alignment/stage-3-contracts-partners')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'Phase 4 Stage 3 — Contract.partner → BusinessPartner readiness' })
  async modelAlignmentStage3() {
    const contracts = await this.prisma.contract.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        partnerId: true,
        partner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            businessPartnerId: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    const contractsWithPartnerUser = contracts.map((c) => {
      const p = c.partner;
      const name = p
        ? [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || `#${p.id}`
        : `#${c.partnerId}`;
      return {
        contractId: c.id,
        contractCode: c.name ?? null,
        partnerUserId: c.partnerId,
        partnerUserName: name,
        partnerBusinessPartnerId: p?.businessPartnerId ?? null,
      };
    });

    const contractsWithoutPartnerBp = contractsWithPartnerUser
      .filter((r) => r.partnerBusinessPartnerId == null)
      .map((r) => ({
        contractId: r.contractId,
        contractCode: r.contractCode,
        partnerUserId: r.partnerUserId,
        partnerUserName: r.partnerUserName,
        reason: 'partner-user-has-no-BP' as const,
      }));

    return { contractsWithPartnerUser, contractsWithoutPartnerBp };
  }

  /**
   * Stage 4 — TeamTemplateMember → ProjectRoleType mapping preview.
   *
   * Retirement (2026-09-28): the legacy free-text `role` column is
   * gone. The preview now reports the distribution of catalog
   * ProjectRoleType assignments (`projectRoleTypeId`) across every
   * TeamTemplateMember row, plus the null/empty bucket for members
   * that will land as the D9 "Team member" default when applied.
   */
  @Get('model-alignment/stage-4-template-role-mapping')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'Phase 4 Stage 4 — TeamTemplateMember → ProjectRoleType distribution' })
  async modelAlignmentStage4() {
    const roleTypes = await this.prisma.projectRoleType.findMany({
      select: { id: true, code: true, name: true },
    });
    const roleTypeById = new Map<number, { id: number; code: string; name: string }>();
    for (const r of roleTypes) roleTypeById.set(r.id, r);

    const groups = await this.prisma.teamTemplateMember.groupBy({
      by: ['projectRoleTypeId'],
      _count: { _all: true },
    });

    let nullOrEmpty = 0;
    const memberRoleTypes: Array<{
      matchedProjectRoleTypeId: number;
      matchedProjectRoleTypeName: string | null;
      matchedProjectRoleTypeCode: string | null;
      memberCount: number;
    }> = [];

    for (const g of groups) {
      if (g.projectRoleTypeId == null) {
        nullOrEmpty += g._count._all;
        continue;
      }
      const rt = roleTypeById.get(g.projectRoleTypeId) ?? null;
      memberRoleTypes.push({
        matchedProjectRoleTypeId: g.projectRoleTypeId,
        matchedProjectRoleTypeName: rt?.name ?? null,
        matchedProjectRoleTypeCode: rt?.code ?? null,
        memberCount: g._count._all,
      });
    }
    memberRoleTypes.sort((a, b) => b.memberCount - a.memberCount);

    return { memberRoleTypes, nullOrEmpty };
  }
}
