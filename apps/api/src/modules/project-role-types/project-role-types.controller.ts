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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildEligibleWhere,
  extractEligibilityRule,
} from '../projects/role-eligibility';

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
  // Used by the New-Project picker (where there's no projectId yet) and
  // any picker that wants to show ONLY the parties `create()` on
  // ProjectPartnerRole would accept. The FE previously called
  // `/business-partners` with `partnerType + roleType` params, missing
  // the requiredProfessionIds filter — so ineligible people surfaced
  // and then 400'd on add. This endpoint returns exactly the set the
  // write-side accepts.
  //
  // Gate: `partners:read`, same as the /business-partners endpoint the
  // picker was previously calling. Anyone who can pick a party can call
  // this. Response shape mirrors /business-partners so the picker's
  // existing consumer code doesn't have to change.
  @Get(':code/eligible-parties')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List parties eligible for a project role (all three checks combined)' })
  async eligibleParties(@Param('code') rawCode: string) {
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
    const parties = await this.prisma.businessPartner.findMany({
      where: buildEligibleWhere(rule),
      select: {
        id: true,
        partnerType: true,
        displayName: true,
        firstName: true,
        lastName: true,
        email: true,
        user: { select: { id: true, avatarUrl: true, position: true, department: true } },
      },
      orderBy: [{ displayName: 'asc' }],
    });
    return parties.map((p) => ({
      id: p.id,
      partnerType: p.partnerType,
      displayName: p.displayName,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      avatarUrl: p.user?.avatarUrl ?? null,
      position: p.user?.position ?? null,
      department: p.user?.department ?? null,
    }));
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
