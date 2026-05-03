import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

interface UpsertTypeDto {
  code?: string;                    // required for create, optional for update (system rows can't change code)
  name: string;
  description?: string;
  applicableTargetTypes?: string;   // CSV — only used by relationship types
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

  @Post('role-types')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Create a custom role type' })
  async createRoleType(@Body() body: UpsertTypeDto) {
    if (!body.code?.trim() || !body.name?.trim()) {
      throw new BadRequestException('code and name are required');
    }
    return this.prisma.partnerRoleType.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
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

  @Post('relationship-types')
  @RequirePermissions({ module: 'admin/partner-types', action: 'write' })
  @ApiOperation({ summary: 'Create a custom relationship type' })
  async createRelationshipType(@Body() body: UpsertTypeDto) {
    if (!body.code?.trim() || !body.name?.trim()) {
      throw new BadRequestException('code and name are required');
    }
    return this.prisma.partnerRelationshipType.create({
      data: {
        code: body.code.trim().toLowerCase(),
        name: body.name.trim(),
        description: body.description?.trim() || null,
        applicableTargetTypes: body.applicableTargetTypes?.trim() || null,
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

    const data: any = {
      name: body.name?.trim(),
      description: body.description?.trim() ?? null,
      applicableTargetTypes: body.applicableTargetTypes?.trim() ?? null,
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
