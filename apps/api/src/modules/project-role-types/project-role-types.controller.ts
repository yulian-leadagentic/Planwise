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
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { extractEligibilityRule } from '../projects/role-eligibility';

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
  constructor(private prisma: PrismaService) {}

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
  // Gate: `partners:read`, same as the /business-partners endpoint the
  // picker was previously calling. Anyone who can pick a party can call
  // this.
  @Get(':code/eligible-parties')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List parties for a project role, annotated with eligibility + reasons' })
  async eligibleParties(
    @Param('code') rawCode: string,
    @Query() query: { projectId?: string },
  ) {
    const code = rawCode?.trim().toLowerCase();
    if (!code) throw new BadRequestException('code is required');
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
            avatarUrl: true,
            position: true,
            // Retire-User.department Step 3/3 (2026-09-28) — OrgUnit is
            // the sole source for the picker's `department` subtitle.
            orgUnit: { select: { id: true, name: true } },
          },
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

    return parties.map((p) => {
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
