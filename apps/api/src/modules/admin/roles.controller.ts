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
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { StageTransitionService } from '../../common/services/stage-transition.service';
import { ResourceOverrideService } from '../../common/services/resource-override.service';

/**
 * Permissions round 1 (2026-11-20) — decision 3: an Admin may grant
 * himself finance / hr, provided every permission change is audited.
 * Role create / update / delete and every role-module grant change
 * writes a `security` activity row (actor, role, before → after).
 */
@ApiTags('Admin - Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/roles')
export class RolesController {
  constructor(
    private prisma: PrismaService,
    private stageTransitions: StageTransitionService,
    private resourceOverrides: ResourceOverrideService,
    private activityLog: ActivityLogService,
  ) {}

  @Post()
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Create a role' })
  async create(@Body() body: { name: string; description?: string }, @CurrentUser() actor: any) {
    const role = await this.prisma.role.create({
      data: { name: body.name, description: body.description },
      include: { roleModules: { include: { module: true } } },
    });
    await this.activityLog.logSecurityEvent({
      action: 'role.create',
      description: `Created role "${role.name}"`,
      actorUserId: actor?.id ?? null,
      entityType: 'role',
      entityId: role.id,
      entityName: role.name,
      changes: { name: { from: null, to: role.name }, description: { from: null, to: role.description ?? null } },
    });
    return role;
  }

  @Get()
  @RequirePermissions({ module: 'admin/roles', action: 'read' })
  @ApiOperation({ summary: 'List all roles' })
  async findAll() {
    return this.prisma.role.findMany({
      include: {
        roleModules: { include: { module: true } },
        _count: { select: { users: true } },
      },
      orderBy: { id: 'asc' },
    });
  }

  @Get(':id')
  @RequirePermissions({ module: 'admin/roles', action: 'read' })
  @ApiOperation({ summary: 'Get role by ID' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.prisma.role.findUnique({
      where: { id },
      include: {
        roleModules: { include: { module: true } },
        _count: { select: { users: true } },
      },
    });
  }

  @Patch(':id')
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Update a role' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; description?: string },
    @CurrentUser() actor: any,
  ) {
    // Phase 1 RBAC Hardening (2026-10-20 WORKORDER — B2b) — system
    // roles stay NON-RENAMABLE. The role name is the join key the
    // seed uses to re-assert grants, and the FE's isSystem rendering
    // depends on stable names ("HR Manager", "Admin", …). Changing
    // description is still allowed so admins can relabel the group
    // without breaking the seed contract.
    if (body.name !== undefined) {
      const role = await this.prisma.role.findUnique({
        where: { id },
        select: { id: true, name: true, isSystem: true },
      });
      if (!role) throw new ForbiddenException('Role not found');
      if (role.isSystem && body.name !== role.name) {
        throw new ForbiddenException(
          `ROLE_IS_SYSTEM: "${role.name}" is a system group — its name is managed by code (apps/api/prisma/seed.ts §14.1 grid). You can edit the description, or create a non-system role with a different name.`,
        );
      }
    }
    const before = await this.prisma.role.findUnique({ where: { id } });
    const updated = await this.prisma.role.update({
      where: { id },
      data: body,
    });
    // before → after for every field the body touched (values only, no
    // secrets live on a role row).
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(body ?? {})) {
      const from = (before as any)?.[key] ?? null;
      const to = (updated as any)?.[key] ?? null;
      if (from !== to) changes[key] = { from, to };
    }
    if (Object.keys(changes).length > 0) {
      await this.activityLog.logSecurityEvent({
        action: 'role.update',
        description: `Updated role "${updated.name}" — ${Object.keys(changes).join(', ')}`,
        actorUserId: actor?.id ?? null,
        entityType: 'role',
        entityId: id,
        entityName: updated.name,
        changes: changes as any,
      });
    }
    return updated;
  }

  @Delete(':id')
  @RequirePermissions({ module: 'admin/roles', action: 'delete' })
  @ApiOperation({ summary: 'Delete a role' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: any) {
    // Phase 1 RBAC Hardening (2026-10-20 WORKORDER — B2b) — system
    // roles stay NON-DELETABLE. The seed would just re-create them
    // on next boot (upsert by name) and silently re-grant their
    // grid; a delete here would also strand any user currently
    // assigned to that role. Non-system roles delete normally.
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: { id: true, name: true, isSystem: true },
    });
    if (!role) throw new ForbiddenException('Role not found');
    if (role.isSystem) {
      throw new ForbiddenException(
        `ROLE_IS_SYSTEM: "${role.name}" is a system group — it cannot be deleted. The seed would re-create it on next boot. Edit its permissions in the matrix instead, or move its users to a different role first.`,
      );
    }

    // Clean up all related records before deleting the role.
    // RoleStageTransition and ResourceOverride have onDelete:Cascade
    // in the schema, but RoleModule does not — must delete manually.
    await this.prisma.$transaction([
      this.prisma.roleModule.deleteMany({ where: { roleId: id } }),
      this.prisma.roleStageTransition.deleteMany({ where: { roleId: id } }),
      this.prisma.resourceOverride.deleteMany({ where: { roleId: id } }),
      this.prisma.role.delete({ where: { id } }),
    ]);
    await this.activityLog.logSecurityEvent({
      action: 'role.delete',
      description: `Deleted role "${role.name}"`,
      actorUserId: actor?.id ?? null,
      entityType: 'role',
      entityId: id,
      entityName: role.name,
      severity: 'critical',
      changes: { name: { from: role.name, to: null } },
    });
    return { message: 'Role deleted' };
  }

  // Role Modules (permissions)
  @Post(':id/modules')
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Set module permissions for role' })
  async setModulePermission(
    @Param('id', ParseIntPipe) roleId: number,
    @Body() body: { moduleId: number; canRead: boolean; canWrite: boolean; canDelete: boolean; canApprove?: boolean; canExport?: boolean },
    @CurrentUser() actor: any,
  ) {
    // Phase 1 RBAC Hardening (2026-10-20 WORKORDER — B2b) — module
    // grants on system roles ARE editable. The previous
    // ROLE_IS_SYSTEM block here was blocking admins from managing
    // permissions in the UI, which pushed them to hand-edit the DB
    // or add workaround module groups. The seed is additive now
    // (seed.ts §14 — never deletes an existing row), so admin edits
    // persist across boots. Role rename / delete are still gated —
    // see PATCH + DELETE above.
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, isSystem: true },
    });
    if (!role) throw new ForbiddenException('Role not found');

    const existing = await this.prisma.roleModule.findFirst({
      where: { roleId, moduleId: body.moduleId },
    });

    const permData = {
      canRead: body.canRead,
      canWrite: body.canWrite,
      canDelete: body.canDelete,
      canApprove: body.canApprove ?? false,
      canExport: body.canExport ?? false,
    };

    const saved = existing
      ? await this.prisma.roleModule.update({
          where: { id: existing.id },
          data: permData,
          include: { module: true },
        })
      : await this.prisma.roleModule.create({
          data: { roleId, moduleId: body.moduleId, ...permData },
          include: { module: true },
        });

    const before = existing ? pickFlags(existing) : null;
    const after = pickFlags(saved);
    if (!before || FLAG_KEYS.some((k) => before[k] !== after[k])) {
      const moduleLabel = saved.module?.route || saved.module?.name || `module #${body.moduleId}`;
      await this.activityLog.logSecurityEvent({
        action: existing ? 'role.module_change' : 'role.module_grant',
        description: `${existing ? 'Changed' : 'Granted'} ${moduleLabel} on role "${role.name}": ${formatFlags(before)} → ${formatFlags(after)}`,
        actorUserId: actor?.id ?? null,
        entityType: 'role',
        entityId: roleId,
        entityName: role.name,
        changes: {
          module: { id: body.moduleId, route: saved.module?.route ?? null, name: saved.module?.name ?? null },
          permissions: { from: before, to: after },
        },
      });
    }
    return saved;
  }

  @Delete(':id/modules/:moduleId')
  @RequirePermissions({ module: 'admin/roles', action: 'delete' })
  @ApiOperation({ summary: 'Remove module permission from role' })
  async removeModulePermission(
    @Param('id', ParseIntPipe) roleId: number,
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @CurrentUser() actor: any,
  ) {
    // Phase 1 RBAC Hardening (2026-10-20 WORKORDER — B2b) — removing
    // a module from a system role is now allowed. Note the seed will
    // re-add the row with its grid defaults on next boot IF the
    // grid lists this module for this role (that is the additive-
    // catch-up behavior; to "deny" a grant, leave the row with 0
    // permissions instead of deleting it). See seed.ts §14 for the
    // full contract.
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, name: true, isSystem: true },
    });
    if (!role) throw new ForbiddenException('Role not found');

    const existing = await this.prisma.roleModule.findFirst({
      where: { roleId, moduleId },
      include: { module: true },
    });

    if (existing) {
      await this.prisma.roleModule.delete({ where: { id: existing.id } });
      const moduleLabel = existing.module?.route || existing.module?.name || `module #${moduleId}`;
      await this.activityLog.logSecurityEvent({
        action: 'role.module_revoke',
        description: `Revoked ${moduleLabel} from role "${role.name}": ${formatFlags(pickFlags(existing))} → none`,
        actorUserId: actor?.id ?? null,
        entityType: 'role',
        entityId: roleId,
        entityName: role.name,
        changes: {
          module: { id: moduleId, route: existing.module?.route ?? null, name: existing.module?.name ?? null },
          permissions: { from: pickFlags(existing), to: null },
        },
      });
    }

    return { message: 'Module permission removed' };
  }

  // ─── Users with this role (inverse lookup) ─────────────────────────

  @Get(':id/users')
  @RequirePermissions({ module: 'admin/roles', action: 'read' })
  @ApiOperation({ summary: 'List users assigned to this role' })
  async findUsers(@Param('id', ParseIntPipe) roleId: number) {
    return this.prisma.user.findMany({
      where: { roleId, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        avatarUrl: true,
        userType: true,
        position: true,
        // Retire-User.department Step 3/3 — OrgUnit only.
        orgUnitId: true,
        orgUnit: { select: { id: true, name: true } },
        isActive: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
  }

  // ─── Stage Transitions ────────────────────────────────────────────

  @Get(':id/stage-transitions')
  @RequirePermissions({ module: 'admin/roles', action: 'read' })
  @ApiOperation({ summary: 'Get stage transition matrix for a role' })
  async getStageTransitions(@Param('id', ParseIntPipe) roleId: number) {
    return this.stageTransitions.getMatrix(roleId);
  }

  @Post(':id/stage-transitions')
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Set the full stage transition matrix for a role' })
  async setStageTransitions(
    @Param('id', ParseIntPipe) roleId: number,
    @Body() body: { transitions: { from: string; to: string }[] },
  ) {
    await this.stageTransitions.setMatrix(roleId, body.transitions ?? []);
    return this.stageTransitions.getMatrix(roleId);
  }

  // ─── Resource Overrides ───────────────────────────────────────────

  @Get('resource-overrides/:resourceType/:resourceId')
  @RequirePermissions({ module: 'admin/roles', action: 'read' })
  @ApiOperation({ summary: 'List permission overrides for a resource' })
  async listOverrides(
    @Param('resourceType') resourceType: string,
    @Param('resourceId', ParseIntPipe) resourceId: number,
  ) {
    return this.resourceOverrides.listOverrides(resourceType, resourceId);
  }

  @Post('resource-overrides')
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Set a permission override for a resource + role/user' })
  async setOverride(
    @Body() body: {
      resourceType: string;
      resourceId: number;
      roleId?: number;
      userId?: number;
      canRead: boolean;
      canWrite: boolean;
      canDelete: boolean;
    },
  ) {
    return this.resourceOverrides.setOverride(body);
  }

  @Delete('resource-overrides/:id')
  @RequirePermissions({ module: 'admin/roles', action: 'delete' })
  @ApiOperation({ summary: 'Remove a permission override' })
  async removeOverride(@Param('id', ParseIntPipe) id: number) {
    return this.resourceOverrides.removeOverride(id);
  }
}

const FLAG_KEYS = ['canRead', 'canWrite', 'canDelete', 'canApprove', 'canExport'] as const;
type Flags = Record<(typeof FLAG_KEYS)[number], boolean>;

function pickFlags(rm: Partial<Record<(typeof FLAG_KEYS)[number], boolean | null>>): Flags {
  return {
    canRead: !!rm.canRead,
    canWrite: !!rm.canWrite,
    canDelete: !!rm.canDelete,
    canApprove: !!rm.canApprove,
    canExport: !!rm.canExport,
  };
}

/** "RW--E"-style summary for the activity-log description. */
function formatFlags(flags: Flags | null): string {
  if (!flags) return 'none';
  const letters = ['R', 'W', 'D', 'A', 'E'];
  return FLAG_KEYS.map((k, i) => (flags[k] ? letters[i] : '-')).join('');
}
