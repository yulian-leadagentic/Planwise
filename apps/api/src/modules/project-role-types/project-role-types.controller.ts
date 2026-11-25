import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { extractEligibilityRule } from '../projects/role-eligibility';
import {
  type HomeOrgContext,
  isInternalParty,
  loadHomeOrgContext,
  parseOrganizationFilter,
  parseQueryFlag,
} from './internal-party';

interface UpsertProjectRoleTypeDto {
  code?: string;
  name: string;
  description?: string;
  // M4a.3 — 'any' removed; project roles attach to either person OR
  // organization, never both.
  allowedPartnerKind?: 'person' | 'organization';
  requiredPartnerRoleCode?: string | null;
  // Multi-select of Profession.id values. When non-empty, the party must
  // hold at least one of these professions ("Job Titles" in the UI).
  requiredProfessionIds?: number[] | null;
  isPrimaryRequired?: boolean;
  // BM2 Phase 6 (2026-08-13) — UI hint that the operational
  // add-participant flow should require a contact person when the
  // participant is an org. Drives ProjectPartnerRole.contactPartyId.
  requiresContactPerson?: boolean;
  sortOrder?: number;
}

@ApiTags('Admin - Project Role Types')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/project-role-types')
export class ProjectRoleTypesController {
  constructor(
    private prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get()
  @RequirePermissions({ module: 'admin/project-role-types', action: 'read' })
  list() {
    return this.prisma.projectRoleType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  @Post()
  @RequirePermissions({ module: 'admin/project-role-types', action: 'write' })
  @ApiOperation({ summary: 'Create a custom project role type' })
  async create(@Body() body: UpsertProjectRoleTypeDto) {
    if (!body.code?.trim() || !body.name?.trim()) {
      throw new BadRequestException('code and name are required');
    }
    return this.prisma.projectRoleType.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        allowedPartnerKind: body.allowedPartnerKind ?? 'person',
        requiredPartnerRoleCode: body.requiredPartnerRoleCode || null,
        requiredProfessionIds:
          body.requiredProfessionIds && body.requiredProfessionIds.length > 0
            ? (body.requiredProfessionIds as Prisma.InputJsonValue)
            : Prisma.DbNull,
        isPrimaryRequired: body.isPrimaryRequired ?? false,
        requiresContactPerson: body.requiresContactPerson ?? false,
        sortOrder: body.sortOrder ?? 0,
        isSystem: false,
      },
    });
  }

  @Patch(':id')
  @RequirePermissions({ module: 'admin/project-role-types', action: 'write' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpsertProjectRoleTypeDto,
  ) {
    const existing = await this.prisma.projectRoleType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Project role type not found');

    const data: any = {
      name: body.name?.trim(),
      description: body.description?.trim() ?? null,
      allowedPartnerKind: body.allowedPartnerKind,
      requiredPartnerRoleCode:
        body.requiredPartnerRoleCode === undefined ? undefined : (body.requiredPartnerRoleCode || null),
      requiredProfessionIds:
        body.requiredProfessionIds === undefined
          ? undefined
          : body.requiredProfessionIds && body.requiredProfessionIds.length > 0
            ? (body.requiredProfessionIds as Prisma.InputJsonValue)
            : Prisma.DbNull,
      isPrimaryRequired: body.isPrimaryRequired,
      requiresContactPerson: body.requiresContactPerson,
      sortOrder: body.sortOrder,
    };
    // System rows: code is locked.
    if (!existing.isSystem && body.code) {
      data.code = body.code.trim().toLowerCase();
    }
    return this.prisma.projectRoleType.update({ where: { id }, data });
  }

  // QA3 round-5 (PR-023) — project-independent eligible-parties list.
  //
  // Used by every project-role picker in the app: the Team tab
  // (RoleAssignmentPicker), New Project (TeamRolePicker), and the
  // project-list role cell (RoleHolderCell). See docs/bm2/people-ux-work-order.md §M3.
  //
  // People UX M3 (2026-09-27, T-02/T-03/T-20/T-21):
  //   1. Optional `projectId` query param — when provided, parties
  //      already actively assigned to that project on ANY role are
  //      excluded, so the picker doesn't offer names the write path
  //      would reject with a unique-constraint violation. Backward-
  //      compatible: omit it and the list is the project-independent
  //      set (used by New Project where no project exists yet).
  //   2. Returns INELIGIBLE parties too, annotated with
  //      `eligible: false` + `reasons: string[]` in plain English
  //      ("Needs job title: BIM Manager", "Must be an employee").
  //      The FE renders them disabled with the reason visible, so
  //      users see WHY someone is missing instead of just missing them.
  //   3. `userId` (nullable) is included so the project-list role cell
  //      — which keys PeopleMultiSelect on User.id — can key off the
  //      same payload without a second lookup.
  //
  // QA6 BM2-4 (2026-11-25) — organization-first picking for external
  // roles. Two optional, backward-compatible query params:
  //   • `excludeInternal=true` drops AMEC: the home org itself, people
  //     with an active `worker_of` edge to it, and D1 employees (login
  //     user on a home-org domain). See `internal-party.ts`.
  //   • `organizationId=<id>` keeps only that organization (when the
  //     role's kind allows an org) and the people with an active
  //     `worker_of` edge to it; `organizationId=none` keeps only people
  //     with no active employer. Anything else is a 400, so a typo can
  //     never widen the list back to everyone.
  // Each person row now carries `employers` (active worker_of orgs) so
  // the picker can build its organization list from one payload.
  //
  // Gate: `partners:read`, same as the /business-partners endpoint the
  // picker was previously calling. Anyone who can pick a party can call
  // this.
  @Get(':code/eligible-parties')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List parties for a project role, annotated with eligibility + reasons' })
  async eligibleParties(
    @CurrentUser() user: any,
    @Param('code') rawCode: string,
    @Query() query: { projectId?: string; organizationId?: string; excludeInternal?: string },
  ) {
    const code = rawCode?.trim().toLowerCase();
    if (!code) throw new BadRequestException('code is required');
    const orgFilter = parseOrganizationFilter(query.organizationId);
    if (orgFilter === null) {
      throw new BadRequestException('organizationId must be an organization id or "none"');
    }
    const excludeInternal = parseQueryFlag(query.excludeInternal);
    const role = await this.prisma.projectRoleType.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        name: true,
        allowedPartnerKind: true,
        requiredPartnerRoleCode: true,
        requiredProfessionIds: true,
      },
    });
    if (!role) {
      throw new NotFoundException(`Project role type '${code}' not found`);
    }
    const rule = extractEligibilityRule(role);

    // Kind is a hard filter — a person-role can never accept an org,
    // and vice versa. Showing wrong-kind parties as "ineligible" would
    // pollute the picker with hundreds of unrelated names. The other
    // two checks (required partner-role, required professions) are soft
    // — parties that fail them are still returned, annotated.
    const kindWhere: Prisma.BusinessPartnerWhereInput = { deletedAt: null };
    if (rule.allowedPartnerKind === 'person' || rule.allowedPartnerKind === 'organization') {
      kindWhere.partnerType = rule.allowedPartnerKind;
    }

    // Optional projectId scope — exclude parties already assigned to
    // this project on ANY active role. Matches the FE's previous
    // client-side `existingPartyIds` filter, moved to the server so
    // every picker gets the same set without duplicating the join.
    const projectIdNum = query.projectId ? Number(query.projectId) : NaN;
    let alreadyAssigned: Set<number> = new Set();
    if (Number.isFinite(projectIdNum) && projectIdNum > 0) {
      // Round 4 (review fix) — the exclusion list reveals the project's
      // team, so the caller needs access to that project.
      await this.access.assertProjectAccess(user.id, projectIdNum, isAdminUser(user));
      const now = new Date();
      const existing = await this.prisma.projectPartnerRole.findMany({
        where: {
          projectId: projectIdNum,
          status: 'active',
          validFrom: { lte: now },
          validTo: { gt: now },
        },
        select: { partyId: true },
      });
      alreadyAssigned = new Set(existing.map((r) => r.partyId));
    }
    if (alreadyAssigned.size > 0) {
      kindWhere.id = { notIn: Array.from(alreadyAssigned) };
    }

    // QA6 BM2-4 — organization scope. Same active-edge test as the
    // /business-partners `employerId` filter (validTo in the future).
    const activeWorkerOf = { type: { code: 'worker_of' }, validTo: { gt: new Date() } };
    if (typeof orgFilter === 'number') {
      const org = await this.prisma.businessPartner.findFirst({
        where: { id: orgFilter, partnerType: 'organization', deletedAt: null },
        select: { id: true },
      });
      if (!org) {
        throw new BadRequestException(`organizationId ${orgFilter} is not an organization`);
      }
      kindWhere.AND = [
        {
          OR: [
            { id: orgFilter },
            {
              partnerType: 'person',
              partnerRelationshipsA: { some: { ...activeWorkerOf, partyBId: orgFilter } },
            },
          ],
        },
      ];
    } else if (orgFilter === 'none') {
      kindWhere.AND = [
        {
          partnerType: 'person',
          partnerRelationshipsA: {
            none: { ...activeWorkerOf, partyB: { deletedAt: null, partnerType: 'organization' } },
          },
        },
      ];
    }

    // QA6 BM2-4 — AMEC exclusion for external roles. Resolved only on
    // request so the default call stays one query lighter.
    let homeCtx: HomeOrgContext | null = null;
    if (excludeInternal) {
      // Same loader as the write path (ProjectPartnerRolesService, QA6).
      homeCtx = await loadHomeOrgContext(this.prisma);
      // Everyone at the home org is internal, so its list is empty by
      // definition.
      if (typeof orgFilter === 'number' && orgFilter === homeCtx.homeOrgId) return [];
    }

    const parties = await this.prisma.businessPartner.findMany({
      where: kindWhere,
      select: {
        id: true,
        partnerType: true,
        displayName: true,
        firstName: true,
        lastName: true,
        email: true,
        user: {
          select: {
            id: true,
            // QA6 BM2-4 — read for the D1 employee rule only; not echoed.
            email: true,
            avatarUrl: true,
            position: true,
            // Retire-User.department Step 3/3 (2026-09-28) — OrgUnit is
            // the sole source for the picker's `department` subtitle.
            orgUnit: { select: { id: true, name: true } },
          },
        },
        // QA6 BM2-4 — active employers (worker_of → live organization).
        partnerRelationshipsA: {
          where: {
            ...activeWorkerOf,
            partyB: { deletedAt: null, partnerType: 'organization' },
          },
          select: { partyB: { select: { id: true, displayName: true } } },
        },
        // Match the write path: it just does `party.roles.some(...)`
        // with no validTo filter (project-partner-roles.service :124),
        // so we mirror that here to avoid the picker rejecting parties
        // the write side accepts.
        roles: {
          select: { roleType: { select: { code: true } } },
        },
        professions: {
          select: { professionId: true },
        },
      },
      orderBy: [{ displayName: 'asc' }],
    });

    // Fetch the human-readable profession names once so we can quote
    // them in the "Needs job title: …" reason. Cheap: typical catalogs
    // have <100 rows.
    const profNameById = new Map<number, string>();
    if (rule.requiredProfessionIds.length > 0) {
      const rows = await this.prisma.profession.findMany({
        where: { id: { in: rule.requiredProfessionIds } },
        select: { id: true, name: true },
      });
      for (const r of rows) profNameById.set(r.id, r.name);
    }
    const requiredProfLabel = rule.requiredProfessionIds.length > 0
      ? rule.requiredProfessionIds
          .map((id) => profNameById.get(id))
          .filter((n): n is string => !!n)
          .join(' or ')
      : null;

    // People UX M4 glossary — surface "Employee" / "Organization" /
    // "Contact" in reasons, never the raw partner-role code / raw
    // partnerType. Matches the wording on the picker banner so the
    // criteria and the row-level reason read as one voice.
    // TA-2: labels are lowercase so grammar reads naturally ("Must be an
    // employee", "Must be a customer") and matches the client's
    // CRITERIA block. The `article()` helper picks a/an by first letter
    // — the tiny helper is duplicated in role-assignment-picker.tsx;
    // extracting it to a shared package is not worth the plumbing for
    // one string.
    const roleCodeToLabel: Record<string, string> = {
      employee: 'employee',
      customer: 'customer',
      supplier: 'supplier',
      partner: 'partner',
    };
    const humaniseRoleCode = (c: string): string =>
      roleCodeToLabel[c] ?? c.replace(/_/g, ' ').toLowerCase();
    const article = (word: string): 'a' | 'an' => {
      const first = word.trim().charAt(0).toLowerCase();
      return 'aeiou'.includes(first) ? 'an' : 'a';
    };

    const withEmployers = parties.map((p) => ({
      party: p,
      employers: p.partnerType === 'person'
        ? (p.partnerRelationshipsA ?? []).map((r) => r.partyB)
        : [],
    }));
    const ctx = homeCtx;
    const visible = ctx
      ? withEmployers.filter(({ party, employers }) => !isInternalParty(
          {
            id: party.id,
            partnerType: party.partnerType,
            user: party.user,
            employerIds: employers.map((e) => e.id),
          },
          ctx,
        ))
      : withEmployers;

    return visible.map(({ party: p, employers }) => {
      const reasons: string[] = [];
      // Rule 1 — allowedPartnerKind. Filtered out server-side, but the
      // annotation stays in case a future call widens the query.
      if (
        rule.allowedPartnerKind
        && rule.allowedPartnerKind !== 'any'
        && rule.allowedPartnerKind !== p.partnerType
      ) {
        reasons.push(
          rule.allowedPartnerKind === 'organization'
            ? `Must be ${article('organization')} organization`
            : `Must be ${article('person contact')} person contact`,
        );
      }
      // Rule 2 — requiredPartnerRoleCode.
      if (rule.requiredPartnerRoleCode) {
        const holds = p.roles.some(
          (r) => r.roleType.code === rule.requiredPartnerRoleCode,
        );
        if (!holds) {
          const name = humaniseRoleCode(rule.requiredPartnerRoleCode);
          reasons.push(`Must be ${article(name)} ${name}`);
        }
      }
      // Rule 3 — requiredProfessionIds (Job Titles).
      if (rule.requiredProfessionIds.length > 0) {
        const partyProfIds = new Set(p.professions.map((x) => x.professionId));
        const hit = rule.requiredProfessionIds.some((id) => partyProfIds.has(id));
        if (!hit) {
          reasons.push(
            requiredProfLabel
              ? `Needs job title: ${requiredProfLabel}`
              : 'Needs a required job title',
          );
        }
      }
      return {
        id: p.id,
        userId: p.user?.id ?? null,
        partnerType: p.partnerType,
        displayName: p.displayName,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        avatarUrl: p.user?.avatarUrl ?? null,
        position: p.user?.position ?? null,
        // Retire-User.department Step 3/3 — OrgUnit name only.
        department: (p.user as any)?.orgUnit?.name ?? null,
        // QA6 BM2-4 — active employer organizations (people only).
        employers: employers.map((e) => ({ id: e.id, displayName: e.displayName })),
        eligible: reasons.length === 0,
        reasons,
      };
    });
  }

  @Delete(':id')
  @RequirePermissions({ module: 'admin/project-role-types', action: 'delete' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.projectRoleType.findUnique({
      where: { id },
      include: { _count: { select: { roles: true } } },
    });
    if (!existing) throw new NotFoundException('Project role type not found');
    if (existing.isSystem) {
      throw new BadRequestException('System project role types cannot be deleted');
    }
    if (existing._count.roles > 0) {
      throw new BadRequestException(
        `Cannot delete: ${existing._count.roles} project-role assignment(s) currently use this type.`,
      );
    }
    await this.prisma.projectRoleType.delete({ where: { id } });
    return { message: 'Project role type deleted' };
  }
}
