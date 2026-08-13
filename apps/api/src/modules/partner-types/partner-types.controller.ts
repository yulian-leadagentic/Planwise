import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

/**
 * Structured side target. A side accepts a party if it matches at least
 * one target in the side's list. Within a target, the party must match
 * `kind` AND (if roleCodes set, hold one of those roles) AND/OR (if
 * categoryCodes set, hold a role whose category is one of those).
 */
export interface SideTarget {
  kind: 'person' | 'organization' | 'project' | 'any';
  roleCodes?: string[];
  categoryCodes?: string[];
}

interface UpsertTypeDto {
  code?: string;                    // required for create, optional for update (system rows can't change code)
  name: string;
  description?: string;
  // Coarse grouping label, role types only (e.g. "cst", "sup"). Empty
  // string clears the category; undefined leaves the existing value.
  category?: string;
  // Role types only — restricts the role to a party kind. 'person',
  // 'organization', or 'any' (default — both).
  appliesToKind?: 'person' | 'organization' | 'any';
  // M3a — display labels (free text). The kind/role constraints live in
  // sideATargets/sideBTargets (M3.5); these labels are optional overrides
  // for nicer display.
  sideALabel?: string;
  sideBLabel?: string;
  inverseLabel?: string;
  isSymmetric?: boolean;
  allowsMultiple?: boolean;
  // Structured side definitions — the canonical constraint source since
  // BM2 Phase 1 (the legacy single-shot columns were dropped alongside
  // `business_partner_relationships`). Each side is a list of
  // (kind, optional roles/categories) targets.
  sideATargets?: SideTarget[] | null;
  sideBTargets?: SideTarget[] | null;
  sortOrder?: number;
}

@ApiTags('Admin - Partner Types')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(AuditInterceptor)
@Controller('admin/partner-types')
export class PartnerTypesController {
  constructor(private prisma: PrismaService) {}

  // ─── Role types ───────────────────────────────────────────────────────
  @Get('role-types')
  @RequirePermissions({ module: 'admin/partner-types', action: 'read' })
  @ApiOperation({ summary: 'List partner role types (employee, customer, supplier, ...)' })
  listRoleTypes() {
    return this.prisma.partnerRoleType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  // ─── Role categories ──────────────────────────────────────────────────
  // Catalog of categories (Customer-side, Supplier-side, Internal, …).
  // Each PartnerRoleType references one of these by code. System rows
  // (the four seeds) can be renamed/recoloured but not deleted.
  @Get('categories')
  @RequirePermissions({ module: 'admin/partner-types', action: 'read' })
  @ApiOperation({ summary: 'List partner-role categories' })
  listCategories() {
    return this.prisma.partnerRoleCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  @Post('categories')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Create a partner-role category' })
  async createCategory(@Body() body: { code: string; name: string; description?: string; color?: string; sortOrder?: number }) {
    if (!body.code?.trim() || !body.name?.trim()) {
      throw new BadRequestException('code and name are required');
    }
    const dup = await this.prisma.partnerRoleCategory.findFirst({
      where: { OR: [{ code: body.code.trim().toLowerCase() }, { name: body.name.trim() }] },
    });
    if (dup) {
      throw new BadRequestException(
        `Category already exists: "${dup.name}" (code: ${dup.code}).`,
      );
    }
    return this.prisma.partnerRoleCategory.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        color: body.color?.trim() || null,
        sortOrder: body.sortOrder ?? 0,
        isSystem: false,
      },
    });
  }

  @Patch('categories/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Update a partner-role category (code locked on system rows)' })
  async updateCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { code?: string; name?: string; description?: string | null; color?: string | null; sortOrder?: number },
  ) {
    const existing = await this.prisma.partnerRoleCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    const data: any = {
      name: body.name?.trim(),
      description: body.description === undefined ? undefined : (body.description?.trim() || null),
      color: body.color === undefined ? undefined : (body.color?.trim() || null),
      sortOrder: body.sortOrder,
    };
    // System rows can't change their stable code; non-system rows can
    // (the FK has ON UPDATE CASCADE, so role-types track the rename).
    if (!existing.isSystem && body.code) {
      data.code = body.code.trim().toLowerCase();
    }
    return this.prisma.partnerRoleCategory.update({ where: { id }, data });
  }

  @Delete('categories/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'delete' })
  @ApiOperation({ summary: 'Delete a custom partner-role category (system protected, in-use blocked)' })
  async deleteCategory(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.partnerRoleCategory.findUnique({
      where: { id },
      include: { _count: { select: { roleTypes: true } } },
    });
    if (!existing) throw new NotFoundException('Category not found');
    if (existing.isSystem) {
      throw new BadRequestException('System categories cannot be deleted');
    }
    if (existing._count.roleTypes > 0) {
      throw new BadRequestException(
        `Cannot delete: ${existing._count.roleTypes} role-type(s) currently use this category. Reassign them first.`,
      );
    }
    await this.prisma.partnerRoleCategory.delete({ where: { id } });
    return { message: 'Category deleted' };
  }

  // Legacy endpoint kept for any older client — returns just the codes
  // sourced from the new catalog. Will be dropped in M7.
  @Get('role-types/categories')
  @RequirePermissions({ module: 'admin/partner-types', action: 'read' })
  @ApiOperation({ summary: '[deprecated] List category codes — use GET /categories' })
  async listRoleCategories() {
    const rows = await this.prisma.partnerRoleCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { code: true },
    });
    return rows.map((r) => r.code);
  }

  @Post('role-types')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Create a custom role type' })
  async createRoleType(@Body() body: UpsertTypeDto) {
    if (!body.code?.trim() || !body.name?.trim()) {
      throw new BadRequestException('code and name are required');
    }
    // Duplicate guard.
    const dup = await this.prisma.partnerRoleType.findFirst({
      where: {
        OR: [
          { code: body.code.trim().toLowerCase() },
          { name: body.name.trim() },
        ],
      },
    });
    if (dup) {
      throw new BadRequestException(
        `Role type already exists: "${dup.name}" (code: ${dup.code}).`,
      );
    }
    return this.prisma.partnerRoleType.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        category: body.category?.trim().toLowerCase() || null,
        appliesToKind: body.appliesToKind ?? 'any',
        sortOrder: body.sortOrder ?? 0,
        isSystem: false,
      },
    });
  }

  @Patch('role-types/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Update a role type (system rows: code is locked, name/description editable)' })
  async updateRoleType(@Param('id', ParseIntPipe) id: number, @Body() body: UpsertTypeDto) {
    const existing = await this.prisma.partnerRoleType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Role type not found');

    const data: any = {
      name: body.name?.trim(),
      description: body.description?.trim() ?? null,
      sortOrder: body.sortOrder,
    };
    // category is editable on every row including system ones — admins can
    // re-group the seeded roles. Empty string = clear the category.
    if (body.category !== undefined) {
      const c = body.category?.trim().toLowerCase();
      data.category = c || null;
    }
    if (body.appliesToKind !== undefined) {
      data.appliesToKind = body.appliesToKind;
    }
    // System rows can't change their stable code
    if (!existing.isSystem && body.code) {
      data.code = body.code.trim().toLowerCase();
    }
    return this.prisma.partnerRoleType.update({ where: { id }, data });
  }

  @Delete('role-types/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'delete' })
  @ApiOperation({ summary: 'Delete a custom role type (system rows are protected)' })
  async deleteRoleType(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.partnerRoleType.findUnique({
      where: { id },
      include: { _count: { select: { roles: true } } },
    });
    if (!existing) throw new NotFoundException('Role type not found');
    if (existing.isSystem) {
      throw new BadRequestException('System role types cannot be deleted');
    }
    if (existing._count.roles > 0) {
      throw new BadRequestException(
        `Cannot delete: ${existing._count.roles} business partner(s) currently hold this role.`,
      );
    }
    await this.prisma.partnerRoleType.delete({ where: { id } });
    return { message: 'Role type deleted' };
  }

  // ─── Relationship types ───────────────────────────────────────────────
  @Get('relationship-types')
  @RequirePermissions({ module: 'admin/partner-types', action: 'read' })
  @ApiOperation({ summary: 'List partner relationship types (employee_of, project_manager, ...)' })
  listRelationshipTypes() {
    return this.prisma.partnerRelationshipType.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  // For the AddRelationshipModal: given a relationship-type id and the
  // partner-A that's being edited, return:
  //   - the type's resolved side targets (the array of {kind, roleCodes, categoryCodes})
  //   - eligible party-B candidates that match the type's sideBTargets
  //     AND haven't already got an active relationship of this type with party-A
  //     (the duplicate-prevention guard)
  //   - applicable kind tabs for the picker (e.g. ['project', 'organization'])
  @Get('relationship-types/:id/candidates')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({
    summary:
      'List eligible candidates for an Add Relationship form. Pass forSide=A (default) to find Side-B candidates when the current partner is on Side A; forSide=B to find Side-A candidates when the current partner is on Side B.',
  })
  async listCandidates(
    @Param('id', ParseIntPipe) id: number,
    @Query('partyAId', ParseIntPipe) partnerId: number,
    @Query('forSide') forSide: 'A' | 'B' = 'A',
  ) {
    const type = await this.prisma.partnerRelationshipType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Relationship type not found');

    // If the current partner is on Side A, we look for Side-B candidates;
    // if they're on Side B, we look for Side-A candidates.
    const targets = ((forSide === 'B' ? type.sideATargets : type.sideBTargets) as any[] | null) ?? [];
    const kinds = Array.from(new Set(targets.map((t: any) => t.kind))) as Array<'person' | 'organization' | 'project' | 'any'>;

    // Find existing active rels of this type involving the current partner
    // so we can exclude already-related parties from the candidate list.
    // - Side A view: partner is source, exclude rows where (source=partner, type) already
    // - Side B view: partner is target, exclude rows where (target=partner, type) already
    // BM2 Phase 1 (2026-08-13): reads `partner_relationships` (BUT050 —
    // organizations only). Project-side candidacy for this type is
    // computed in a separate branch below.
    const now = new Date();
    const existingWhere: Prisma.PartnerRelationshipWhereInput = {
      typeId: id,
      validFrom: { lte: now },
      validTo: { gt: now },
      status: 'active',
    };
    if (forSide === 'B') {
      existingWhere.partyBId = partnerId;
    } else {
      existingWhere.partyAId = partnerId;
    }
    const existingRels = await this.prisma.partnerRelationship.findMany({
      where: existingWhere,
      select: { partyAId: true, partyBId: true },
    });
    // From side A: blocked if (partyA=mine, candidate=partyB). From side B:
    // blocked if (candidate=partyA, partyB=mine).
    const blockedIds = new Set<number>(
      existingRels.map((r) => (forSide === 'B' ? r.partyAId : r.partyBId)),
    );

    const result: Record<string, any[]> = {};

    for (const kind of kinds) {
      if (kind === 'project') {
        if (forSide === 'B') continue; // 'project' is never on Side A — skip safely
        // BM2 Phase 1 (2026-08-13): after the split, project participation
        // lives in `project_partner_roles`, not in `partner_relationships`.
        // This branch is a compat leftover for admins who still have a
        // sideTarget with kind='project' on some relationship type. The
        // admin UI (relationship-types tab) drops that option after Phase 1.
        const projectBlocked = new Set<number>();
        const activePprs = await this.prisma.projectPartnerRole.findMany({
          where: {
            partyId: partnerId,
            validFrom: { lte: now },
            validTo: { gt: now },
            status: 'active',
          },
          select: { projectId: true },
        });
        for (const p of activePprs) projectBlocked.add(p.projectId);
        const projects = await this.prisma.project.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, number: true },
          orderBy: { name: 'asc' },
          take: 500,
        });
        result.project = projects
          .filter((p) => !projectBlocked.has(p.id))
          .map((p) => ({ id: p.id, name: p.name, code: p.number }));
      } else if (kind === 'person' || kind === 'organization' || kind === 'any') {
        const matching = targets.filter((t: any) => t.kind === kind || kind === 'any');
        const allowedRoleCodes = new Set<string>();
        const allowedCategoryCodes = new Set<string>();
        let unrestricted = false;
        for (const t of matching) {
          if (!t.roleCodes?.length && !t.categoryCodes?.length) unrestricted = true;
          (t.roleCodes ?? []).forEach((c: string) => allowedRoleCodes.add(c));
          (t.categoryCodes ?? []).forEach((c: string) => allowedCategoryCodes.add(c));
        }

        const partnerWhere: Prisma.BusinessPartnerWhereInput = {
          deletedAt: null,
          id: { not: partnerId },
        };
        if (kind !== 'any') partnerWhere.partnerType = kind;

        const bps = await this.prisma.businessPartner.findMany({
          where: partnerWhere,
          include: { roles: { include: { roleType: true } } },
          orderBy: { displayName: 'asc' },
          take: 500,
        });

        const matchesRoles = (bp: typeof bps[number]) => {
          if (unrestricted) return true;
          return bp.roles.some(
            (r) =>
              allowedRoleCodes.has(r.roleType.code) ||
              (r.roleType.category && allowedCategoryCodes.has(r.roleType.category)),
          );
        };

        result[kind] = bps
          .filter(matchesRoles)
          .filter((bp) => !blockedIds.has(bp.id))
          .map((bp) => ({ id: bp.id, name: bp.displayName, partnerType: bp.partnerType }));
      }
    }

    return {
      type,
      forSide,
      kinds: kinds.filter((k) => !(forSide === 'B' && k === 'project')),
      candidates: result,
      existingCount: existingRels.length,
    };
  }

  @Post('relationship-types')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Create a custom relationship type' })
  async createRelationshipType(@Body() body: UpsertTypeDto) {
    if (!body.code?.trim() || !body.name?.trim()) {
      throw new BadRequestException('code and name are required');
    }
    // Duplicate guard: name OR code already used.
    const existing = await this.prisma.partnerRelationshipType.findFirst({
      where: {
        OR: [
          { code: body.code.trim().toLowerCase() },
          { name: body.name.trim() },
        ],
      },
    });
    if (existing) {
      throw new BadRequestException(
        `Relationship type already exists: "${existing.name}" (code: ${existing.code}). Edit that row instead of creating a duplicate.`,
      );
    }

    // BM2 Phase 1 (2026-08-13): the legacy single-shot columns
    // (sideAKind/sideBKind, applicable*, required*RoleCode) were dropped
    // with the retired `business_partner_relationships` table. All side
    // validation now flows through the structured `sideATargets` /
    // `sideBTargets` JSON. The legacyShimFromTargets helper is kept for
    // any older admin client that still POSTs the flat fields — we
    // silently discard those to avoid a hard 400 breakage.
    return this.prisma.partnerRelationshipType.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        sideALabel: body.sideALabel?.trim() || null,
        sideBLabel: body.sideBLabel?.trim() || null,
        sideATargets: (body.sideATargets as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
        sideBTargets: (body.sideBTargets as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
        inverseLabel: body.inverseLabel?.trim() || null,
        isSymmetric: body.isSymmetric ?? false,
        allowsMultiple: body.allowsMultiple ?? true,
        sortOrder: body.sortOrder ?? 0,
        isSystem: false,
      },
    });
  }

  @Patch('relationship-types/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Update a relationship type (system rows: code is locked)' })
  async updateRelationshipType(@Param('id', ParseIntPipe) id: number, @Body() body: UpsertTypeDto) {
    const existing = await this.prisma.partnerRelationshipType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Relationship type not found');

    // BM2 Phase 1 (2026-08-13): the legacy single-shot columns were
    // dropped alongside `business_partner_relationships`; only the
    // structured `sideATargets` / `sideBTargets` JSON is persisted now.
    const data: any = {
      name: body.name?.trim(),
      description: body.description?.trim() ?? null,
      sideALabel: body.sideALabel?.trim() ?? null,
      sideBLabel: body.sideBLabel?.trim() ?? null,
      sideATargets:
        body.sideATargets === undefined
          ? undefined
          : ((body.sideATargets as Prisma.InputJsonValue | null) ?? Prisma.DbNull),
      sideBTargets:
        body.sideBTargets === undefined
          ? undefined
          : ((body.sideBTargets as Prisma.InputJsonValue | null) ?? Prisma.DbNull),
      inverseLabel: body.inverseLabel?.trim() ?? null,
      isSymmetric: body.isSymmetric,
      allowsMultiple: body.allowsMultiple,
      sortOrder: body.sortOrder,
    };
    if (!existing.isSystem && body.code) {
      data.code = body.code.trim().toLowerCase();
    }
    return this.prisma.partnerRelationshipType.update({ where: { id }, data });
  }

  @Delete('relationship-types/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'delete' })
  @ApiOperation({ summary: 'Delete a custom relationship type (system rows are protected)' })
  async deleteRelationshipType(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.partnerRelationshipType.findUnique({
      where: { id },
      include: { _count: { select: { partnerRelationships: true } } },
    });
    if (!existing) throw new NotFoundException('Relationship type not found');
    if (existing.isSystem) {
      throw new BadRequestException('System relationship types cannot be deleted');
    }
    // BM2 Phase 1 (2026-08-13): usage count now reads from
    // `partner_relationships` (BUT050). The legacy `relationships` count
    // was against the retired `business_partner_relationships` table.
    if (existing._count.partnerRelationships > 0) {
      throw new BadRequestException(
        `Cannot delete: ${existing._count.partnerRelationships} relationship(s) currently use this type.`,
      );
    }
    await this.prisma.partnerRelationshipType.delete({ where: { id } });
    return { message: 'Relationship type deleted' };
  }

  // ─── BM2 Phase 4 · Personal-email domains ─────────────────────────────
  // A tiny catalog of free-mail hosts the import dedup should NEVER treat
  // as a company domain. Lives as a tab under the partner-types-page
  // (per the spec). Seeded with 11 hosts (gmail/yahoo/…); admins can
  // add site-specific ones. `isSystem=true` rows are protected from
  // deletion but their description is editable.

  @Get('personal-email-domains')
  @RequirePermissions({ module: 'admin/partner-types', action: 'read' })
  @ApiOperation({ summary: 'List personal / free-email domains (never bind an org)' })
  listPersonalEmailDomains() {
    return this.prisma.personalEmailDomain.findMany({
      orderBy: [{ isSystem: 'desc' }, { domain: 'asc' }],
    });
  }

  @Post('personal-email-domains')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Add a personal / free-email domain to the never-bind catalog' })
  async createPersonalEmailDomain(@Body() body: { domain: string; description?: string }) {
    const normalized = body.domain?.trim().toLowerCase();
    if (!normalized) throw new BadRequestException('domain is required');
    // Very light validation — a bare host with a dot. Full RFC compliance
    // is overkill for this catalog; typos surface fast in the importer.
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(normalized)) {
      throw new BadRequestException(`"${body.domain}" is not a valid domain (e.g. "gmail.com").`);
    }
    const dup = await this.prisma.personalEmailDomain.findUnique({ where: { domain: normalized } });
    if (dup) {
      throw new BadRequestException(
        `Domain "${normalized}" is already in the catalog (id=${dup.id}).`,
      );
    }
    return this.prisma.personalEmailDomain.create({
      data: {
        domain: normalized,
        description: body.description?.trim() || null,
        isSystem: false,
      },
    });
  }

  @Patch('personal-email-domains/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Update a personal-email domain (system rows: description only)' })
  async updatePersonalEmailDomain(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { domain?: string; description?: string | null },
  ) {
    const existing = await this.prisma.personalEmailDomain.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Personal-email domain not found');
    const data: any = {};
    if (body.description !== undefined) data.description = body.description?.trim() || null;
    if (!existing.isSystem && body.domain) {
      const normalized = body.domain.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(normalized)) {
        throw new BadRequestException(`"${body.domain}" is not a valid domain.`);
      }
      data.domain = normalized;
    }
    return this.prisma.personalEmailDomain.update({ where: { id }, data });
  }

  @Delete('personal-email-domains/:id')
  @RequirePermissions({ module: 'admin/partner-types', action: 'delete' })
  @ApiOperation({ summary: 'Delete a personal-email domain (system rows are protected)' })
  async deletePersonalEmailDomain(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.personalEmailDomain.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Personal-email domain not found');
    if (existing.isSystem) {
      throw new BadRequestException('System personal-email domains cannot be deleted (they ship in code as a fallback).');
    }
    await this.prisma.personalEmailDomain.delete({ where: { id } });
    return { message: 'Personal-email domain deleted' };
  }
}
