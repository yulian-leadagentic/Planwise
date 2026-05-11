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
  // M3a — display labels (free text). The kind/role constraints moved to
  // sideATargets/sideBTargets in M3.5; these labels are now optional
  // overrides for nicer display.
  sideALabel?: string;
  sideBLabel?: string;
  inverseLabel?: string;
  isSymmetric?: boolean;
  allowsMultiple?: boolean;
  // M3.5 — structured side definitions (preferred). Each side is a list
  // of (kind, optional roles/categories) targets. Null/empty falls back
  // to legacy fields below for backward compat.
  sideATargets?: SideTarget[] | null;
  sideBTargets?: SideTarget[] | null;
  // ── Legacy fields — kept until M7. Auto-derived from JSON when the
  //    client writes JSON; auto-fallback for old clients.
  sideAKind?: string;
  sideBKind?: string;
  applicableTargetTypes?: string;   // CSV
  applicableSourceType?: string;    // CSV
  requiredSourceRoleCode?: string;
  requiredTargetRoleCode?: string;
  sortOrder?: number;
}

/**
 * Reduce a SideTarget[] back to (firstKind, firstRoleCode) so the legacy
 * sideAKind / required_source_role_code columns stay consistent. Picks
 * the first entry. Older clients reading just those columns will see a
 * representative slice of the JSON state.
 */
function legacyShimFromTargets(targets: SideTarget[] | null | undefined): {
  kind: string | null;
  requiredRoleCode: string | null;
  applicableKindsCsv: string | null;
} {
  if (!targets || targets.length === 0) return { kind: null, requiredRoleCode: null, applicableKindsCsv: null };
  const first = targets[0];
  const allKinds = Array.from(new Set(targets.map((t) => t.kind))).join(',');
  return {
    kind: first.kind ?? null,
    requiredRoleCode: first.roleCodes?.[0] ?? null,
    applicableKindsCsv: allKinds || null,
  };
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

  // Categories are stored as a free-text column on PartnerRoleType. To
  // avoid users typing garbage variants ("cst", "cust", "customer-side"),
  // the admin UI sources its picker from the DISTINCT values already in
  // use. Returns sorted, deduplicated list of non-empty categories.
  @Get('role-types/categories')
  @RequirePermissions({ module: 'admin/partner-types', action: 'read' })
  @ApiOperation({ summary: 'List distinct category labels currently used by role types' })
  async listRoleCategories() {
    const rows = await this.prisma.partnerRoleType.findMany({
      where: { category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category).filter((c): c is string => !!c);
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
  @ApiOperation({ summary: 'List eligible party-B candidates for an Add Relationship form' })
  async listCandidates(
    @Param('id', ParseIntPipe) id: number,
    @Query('partyAId', ParseIntPipe) partyAId: number,
  ) {
    const type = await this.prisma.partnerRelationshipType.findUnique({ where: { id } });
    if (!type) throw new NotFoundException('Relationship type not found');

    const targets = (type.sideBTargets as any[] | null) ?? [];
    const kinds = Array.from(new Set(targets.map((t: any) => t.kind))) as Array<'person' | 'organization' | 'project' | 'any'>;

    // Find existing active rels of this type from party-A so we can exclude
    // already-related parties from the candidate list.
    const now = new Date();
    const existingRels = await this.prisma.businessPartnerRelationship.findMany({
      where: {
        sourcePartnerId: partyAId,
        relationshipTypeId: id,
        validFrom: { lte: now },
        validTo:   { gt: now },
        status: 'active',
      },
      select: { targetType: true, targetId: true },
    });
    const blockedBy = (kind: string, id: number) =>
      existingRels.some((r) => r.targetType === kind && r.targetId === id);

    const result: Record<string, any[]> = {};

    for (const kind of kinds) {
      if (kind === 'project') {
        const projects = await this.prisma.project.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, number: true },
          orderBy: { name: 'asc' },
          take: 500,
        });
        result.project = projects
          .filter((p) => !blockedBy('project', p.id))
          .map((p) => ({ id: p.id, name: p.name, code: p.number }));
      } else if (kind === 'person' || kind === 'organization' || kind === 'any') {
        // Build role/category filter from ALL targets of this kind (any or specific kind).
        const matching = targets.filter((t: any) => t.kind === kind || (kind === 'any'));
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
          id: { not: partyAId }, // can't relate to self
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
          .filter((bp) => !blockedBy('organization', bp.id)) // blocked-list uses legacy targetType 'organization' for BP-targets
          .map((bp) => ({ id: bp.id, name: bp.displayName, partnerType: bp.partnerType }));
      }
    }

    return {
      type,
      kinds,
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

    // If the client passed structured targets, shim them back into the
    // legacy single-kind columns so the existing relationship service
    // continues to validate against them.
    const aShim = legacyShimFromTargets(body.sideATargets);
    const bShim = legacyShimFromTargets(body.sideBTargets);
    return this.prisma.partnerRelationshipType.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        sideALabel: body.sideALabel?.trim() || null,
        sideBLabel: body.sideBLabel?.trim() || null,
        sideAKind: aShim.kind ?? body.sideAKind?.trim() ?? null,
        sideBKind: bShim.kind ?? body.sideBKind?.trim() ?? null,
        sideATargets: (body.sideATargets as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
        sideBTargets: (body.sideBTargets as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
        inverseLabel: body.inverseLabel?.trim() || null,
        isSymmetric: body.isSymmetric ?? false,
        allowsMultiple: body.allowsMultiple ?? true,
        applicableTargetTypes: bShim.applicableKindsCsv ?? body.applicableTargetTypes?.trim() ?? null,
        applicableSourceType: aShim.applicableKindsCsv ?? body.applicableSourceType?.trim() ?? null,
        requiredSourceRoleCode: aShim.requiredRoleCode ?? body.requiredSourceRoleCode?.trim() ?? null,
        requiredTargetRoleCode: bShim.requiredRoleCode ?? body.requiredTargetRoleCode?.trim() ?? null,
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

    // If client passed targets, derive legacy single-kind cols from them.
    const aShim = legacyShimFromTargets(body.sideATargets);
    const bShim = legacyShimFromTargets(body.sideBTargets);
    const data: any = {
      name: body.name?.trim(),
      description: body.description?.trim() ?? null,
      sideALabel: body.sideALabel?.trim() ?? null,
      sideBLabel: body.sideBLabel?.trim() ?? null,
      sideAKind: body.sideATargets !== undefined ? aShim.kind : (body.sideAKind?.trim() ?? null),
      sideBKind: body.sideBTargets !== undefined ? bShim.kind : (body.sideBKind?.trim() ?? null),
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
      applicableTargetTypes: body.sideBTargets !== undefined ? bShim.applicableKindsCsv : (body.applicableTargetTypes?.trim() ?? null),
      applicableSourceType:  body.sideATargets !== undefined ? aShim.applicableKindsCsv : (body.applicableSourceType?.trim() ?? null),
      requiredSourceRoleCode: body.sideATargets !== undefined ? aShim.requiredRoleCode : (body.requiredSourceRoleCode?.trim() ?? null),
      requiredTargetRoleCode: body.sideBTargets !== undefined ? bShim.requiredRoleCode : (body.requiredTargetRoleCode?.trim() ?? null),
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
      include: { _count: { select: { relationships: true } } },
    });
    if (!existing) throw new NotFoundException('Relationship type not found');
    if (existing.isSystem) {
      throw new BadRequestException('System relationship types cannot be deleted');
    }
    if (existing._count.relationships > 0) {
      throw new BadRequestException(
        `Cannot delete: ${existing._count.relationships} relationship(s) currently use this type.`,
      );
    }
    await this.prisma.partnerRelationshipType.delete({ where: { id } });
    return { message: 'Relationship type deleted' };
  }
}
