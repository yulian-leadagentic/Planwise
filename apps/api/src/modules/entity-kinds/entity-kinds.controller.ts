import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Object Numbering admin surface. Lists the entity kinds (PERSON,
 * ORGANIZATION, EMPLOYEE, PROJECT, CONTRACT, …) and lets the admin
 * (re)assign which NumberRange each one draws from. The PATCH endpoint
 * only updates the assignment + display fields; the catalog rows themselves
 * are seeded by the system migrations.
 */
@ApiTags('Admin - Entity Kinds (Object Numbering)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/entity-kinds')
export class EntityKindsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions({ module: 'admin/number-ranges', action: 'read' })
  @ApiOperation({ summary: 'List entity kinds with their assigned number range' })
  list() {
    return this.prisma.entityKind.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { numberRange: true },
    });
  }

  @Patch(':id')
  @RequirePermissions({ module: 'admin/number-ranges', action: 'write' })
  @ApiOperation({ summary: 'Assign / replace the number range on an entity kind' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { numberRangeCode?: string | null; name?: string; description?: string | null; sortOrder?: number },
  ) {
    const existing = await this.prisma.entityKind.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Entity kind not found');

    // Allow null to clear; otherwise verify the range exists so we surface
    // a friendly error instead of a P2003.
    if (body.numberRangeCode != null && body.numberRangeCode !== '') {
      const range = await this.prisma.numberRange.findUnique({
        where: { code: body.numberRangeCode },
      });
      if (!range) {
        throw new BadRequestException(`Number range "${body.numberRangeCode}" not found`);
      }
    }

    return this.prisma.entityKind.update({
      where: { id },
      data: {
        numberRangeCode:
          body.numberRangeCode === undefined
            ? undefined
            : (body.numberRangeCode === '' ? null : body.numberRangeCode),
        name: body.name?.trim() || undefined,
        description: body.description === undefined ? undefined : (body.description?.trim() || null),
        sortOrder: body.sortOrder,
      },
      include: { numberRange: true },
    });
  }
}
