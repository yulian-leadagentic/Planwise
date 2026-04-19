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

@ApiTags('Admin - Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/roles')
export class RolesController {
  constructor(private prisma: PrismaService) {}

  @Post()
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create a role' })
  async create(@Body() body: { name: string; description?: string }) {
    return this.prisma.role.create({
      data: { name: body.name, description: body.description },
      include: { roleModules: { include: { module: true } } },
    });
  }

  @Get()
  @RequirePermissions({ module: 'admin', action: 'read' })
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
  @RequirePermissions({ module: 'admin', action: 'read' })
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
  @RequirePermissions({ module: 'admin', action: 'write' })
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
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete a role' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.role.delete({ where: { id } });
    return { message: 'Role deleted' };
  }

  // Role Modules (permissions)
  @Post(':id/modules')
  @RequirePermissions({ module: 'admin', action: 'write' })
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
  @RequirePermissions({ module: 'admin', action: 'delete' })
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
}
