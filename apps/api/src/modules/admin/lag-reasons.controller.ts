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
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * B1 (QA-FIX-ALL 2026-11-04) — Admin CRUD for the LagReason catalog.
 * Pairs with the `GET /lookups/lag-reasons` endpoint on the public
 * lookups controller and the FE agent's dependency-lag editor work.
 *
 * Mirrors the `ConfigController` shape (PrismaService injected directly,
 * no separate service, @Controller('admin/config') prefix, @RequirePermissions
 * guard on every route). Kept in a standalone file because the spec asks
 * for a new controller; the module wiring just needs to register it.
 *
 * Deletes are HARD: `TaskDependency.reason` / `TemplateTaskDependency.reason`
 * stay `String?` with NO FK (intentionally loose relation per the work
 * order) so a stale name on a dependency row keeps rendering after the
 * catalog row is deleted. No cascade, no sweep.
 */
@ApiTags('Admin - Config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/config')
export class LagReasonsController {
  constructor(private prisma: PrismaService) {}

  /** List every row (active + inactive) — admin surface renders the full
   *  catalog including the `isActive` toggle. Sorted by sortOrder then
   *  name to match the lookups endpoint's ordering. */
  @Get('lag-reasons')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List lag reasons (admin — includes inactive rows)' })
  async list() {
    return this.prisma.lagReason.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  @Post('lag-reasons')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create a lag reason' })
  async create(
    @Body()
    body: { name: string; nameHe?: string | null; sortOrder?: number; isActive?: boolean },
  ) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    try {
      return await this.prisma.lagReason.create({
        data: {
          name,
          nameHe: body.nameHe?.trim() || null,
          sortOrder: body.sortOrder ?? 0,
          isActive: body.isActive ?? true,
        },
      });
    } catch (err) {
      // P2002 = unique-constraint violation (duplicate `name`).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A lag reason named "${name}" already exists`);
      }
      throw err;
    }
  }

  @Patch('lag-reasons/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update a lag reason (partial)' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      nameHe?: string | null;
      sortOrder?: number;
      isActive?: boolean;
    },
  ) {
    try {
      return await this.prisma.lagReason.update({
        where: { id },
        data: {
          name: body.name?.trim(),
          // Explicit-null clears the Hebrew name; omitting keeps it.
          nameHe: body.nameHe === undefined ? undefined : (body.nameHe?.trim() || null),
          sortOrder: body.sortOrder,
          isActive: body.isActive,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          `A lag reason named "${body.name?.trim()}" already exists`,
        );
      }
      throw err;
    }
  }

  @Delete('lag-reasons/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete a lag reason (hard delete; stale strings remain on dependencies)' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    // Hard delete. `TaskDependency.reason` / `TemplateTaskDependency.reason`
    // keep their string value — the loose relation is intentional.
    await this.prisma.lagReason.delete({ where: { id } });
    return { message: 'Lag reason deleted' };
  }
}
