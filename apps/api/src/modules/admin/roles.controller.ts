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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { StageTransitionService } from '../../common/services/stage-transition.service';
import { ResourceOverrideService } from '../../common/services/resource-override.service';

@ApiTags('Admin - Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/roles')
export class RolesController {
  constructor(
    private prisma: PrismaService,
    private stageTransitions: StageTransitionService,
    private resourceOverrides: ResourceOverrideService,
  ) {}

  @Post()
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Create a role' })
  async create(@Body() body: { name: string; description?: string }) {
    return this.prisma.role.create({
      data: { name: body.name, description: body.description },
      include: { roleModules: { include: { module: true } } },
    });
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
  ) {
    return this.prisma.role.update({
      where: { id },
      data: body,
    });
  }

  @Delete(':id')
  @RequirePermissions({ module: 'admin/roles', action: 'delete' })
  @ApiOperation({ summary: 'Delete a role' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    // Clean up all related records before deleting the role.
    // RoleStageTransition and ResourceOverride have onDelete:Cascade
    // in the schema, but RoleModule does not — must delete manually.
    await this.prisma.$transaction([
      this.prisma.roleModule.deleteMany({ where: { roleId: id } }),
      this.prisma.roleStageTransition.deleteMany({ where: { roleId: id } }),
      this.prisma.resourceOverride.deleteMany({ where: { roleId: id } }),
      this.prisma.role.delete({ where: { id } }),
    ]);
    return { message: 'Role deleted' };
  }

  // Role Modules (permissions)
  @Post(':id/modules')
  @RequirePermissions({ module: 'admin/roles', action: 'write' })
  @ApiOperation({ summary: 'Set module permissions for role' })
  async setModulePermission(
    @Param('id', ParseIntPipe) roleId: number,
    @Body() body: { moduleId: number; canRead: boolean; canWrite: boolean; canDelete: boolean; canApprove?: boolean; canExport?: boolean },
  ) {
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

    if (existing) {
      return this.prisma.roleModule.update({
        where: { id: existing.id },
        data: permData,
        include: { module: true },
      });
    }

    return this.prisma.roleModule.create({
      data: { roleId, moduleId: body.moduleId, ...permData },
      include: { module: true },
    });
  }

  @Delete(':id/modules/:moduleId')
  @RequirePermissions({ module: 'admin/roles', action: 'delete' })
  @ApiOperation({ summary: 'Remove module permission from role' })
  async removeModulePermission(
    @Param('id', ParseIntPipe) roleId: number,
    @Param('moduleId', ParseIntPipe) moduleId: number,
  ) {
    const existing = await this.prisma.roleModule.findFirst({
      where: { roleId, moduleId },
    });

    if (existing) {
      await this.prisma.roleModule.delete({ where: { id: existing.id } });
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
        department: true,
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
