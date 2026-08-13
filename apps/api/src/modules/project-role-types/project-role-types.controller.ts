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
