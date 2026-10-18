import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * §14 RBAC multi-role · Admin → Users surface (2026-10-18).
 *
 * The /admin/users surface currently reuses the main /users controller
 * for list + edit, but the multi-role chip UI needs a dedicated
 * endpoint that writes to the new `user_roles` M2M junction without
 * touching the legacy `users.role_id` (which stays as the "primary
 * (legacy)" display chip, writable via PATCH /users/:id as before).
 *
 * Guarded by `admin:write` — same bar as /admin/roles module edits.
 */
@ApiTags('Admin - Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read every role currently granted to a user. Returns the chip-
   * ready shape the FE multi-select consumes.
   */
  @Get(':id/roles')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: "List a user's granted roles (user_roles M2M)" })
  async listRoles(@Param('id', ParseIntPipe) userId: number) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        roleId: true,
        role: { select: { id: true, name: true, isSystem: true } },
        userRoles: {
          include: {
            role: { select: { id: true, name: true, isSystem: true, description: true } },
          },
          orderBy: { grantedAt: 'asc' },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      userId: user.id,
      primaryLegacyRoleId: user.roleId,
      primaryLegacyRoleName: user.role?.name ?? null,
      roles: user.userRoles.map((ur) => ({
        id: ur.role.id,
        name: ur.role.name,
        isSystem: ur.role.isSystem,
        description: ur.role.description,
        grantedAt: ur.grantedAt.toISOString(),
        grantedById: ur.grantedById,
      })),
    };
  }

  /**
   * Patch a user's role set — add or remove role grants without
   * touching `users.role_id`. `addRoleIds` is upserted via createMany
   * with `skipDuplicates` (idempotent on the (userId, roleId) unique
   * key); `removeRoleIds` is deleted via deleteMany. Returns the new
   * granted-role list in the same shape as GET above.
   *
   * `grantedById` is set from the acting admin's id — so the audit
   * row shows who added the grant.
   */
  @Patch(':id/roles')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({
    summary:
      "Add / remove roles on a user (user_roles M2M; idempotent). Body: { addRoleIds?: number[], removeRoleIds?: number[] }",
  })
  async patchRoles(
    @Param('id', ParseIntPipe) userId: number,
    @Body() body: { addRoleIds?: number[]; removeRoleIds?: number[] },
    @CurrentUser() actor: any,
  ) {
    const addIds = Array.from(new Set((body.addRoleIds ?? []).filter((n) => Number.isInteger(n) && n > 0)));
    const removeIds = Array.from(new Set((body.removeRoleIds ?? []).filter((n) => Number.isInteger(n) && n > 0)));
    if (addIds.length === 0 && removeIds.length === 0) {
      throw new BadRequestException('Nothing to do — pass addRoleIds and/or removeRoleIds.');
    }
    // Guard against passing the same id in both lists.
    const overlap = addIds.filter((id) => removeIds.includes(id));
    if (overlap.length > 0) {
      throw new BadRequestException(
        `Role ids ${overlap.join(',')} appear in both addRoleIds and removeRoleIds.`,
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    // Validate that every id in add[] refers to a real role (deleting
    // a non-existent one is a cheap no-op via deleteMany — no need to
    // validate removeIds).
    if (addIds.length > 0) {
      const foundRoles = await this.prisma.role.findMany({
        where: { id: { in: addIds } },
        select: { id: true },
      });
      const foundSet = new Set(foundRoles.map((r) => r.id));
      const missing = addIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(`Role ids not found: ${missing.join(',')}`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (removeIds.length > 0) {
        await tx.userRole.deleteMany({
          where: { userId, roleId: { in: removeIds } },
        });
      }
      if (addIds.length > 0) {
        await tx.userRole.createMany({
          data: addIds.map((roleId) => ({
            userId,
            roleId,
            grantedById: actor?.id ?? null,
          })),
          // (userId, roleId) is UNIQUE — skipDuplicates swallows the
          // "already granted" case so a double-click or a cross-tab
          // retry stays idempotent.
          skipDuplicates: true,
        });
      }
    });

    // Return the fresh roster. Same shape as the GET for simple FE
    // consumption.
    return this.listRoles(userId);
  }
}
