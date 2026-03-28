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

@ApiTags('Admin - Config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/config')
export class ConfigController {
  constructor(private prisma: PrismaService) {}

  // Project Types
  @Get('project-types')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List project types' })
  async getProjectTypes() {
    return this.prisma.projectType.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { projects: true } } },
    });
  }

  @Post('project-types')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create project type' })
  async createProjectType(@Body() body: { name: string }) {
    return this.prisma.projectType.create({ data: { name: body.name } });
  }

  @Patch('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update project type' })
  async updateProjectType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
  ) {
    return this.prisma.projectType.update({
      where: { id },
      data: { name: body.name },
    });
  }

  @Delete('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete project type' })
  async deleteProjectType(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.projectType.delete({ where: { id } });
    return { message: 'Project type deleted' };
  }

  // Label Types
  @Get('label-types')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List label types' })
  async getLabelTypes() {
    return this.prisma.labelType.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { labels: true } } },
    });
  }

  @Post('label-types')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create label type' })
  async createLabelType(
    @Body() body: { name: string; color: string; icon?: string; sortOrder: number },
  ) {
    return this.prisma.labelType.create({
      data: {
        name: body.name,
        color: body.color,
        icon: body.icon,
        sortOrder: body.sortOrder,
      },
    });
  }

  @Patch('label-types/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update label type' })
  async updateLabelType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; color?: string; icon?: string; sortOrder?: number },
  ) {
    return this.prisma.labelType.update({
      where: { id },
      data: body,
    });
  }

  @Delete('label-types/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete label type' })
  async deleteLabelType(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.labelType.delete({ where: { id } });
    return { message: 'Label type deleted' };
  }

  // Modules (system navigation/permissions)
  @Get('modules')
  @RequirePermissions({ module: 'admin', action: 'read' })
  @ApiOperation({ summary: 'List system modules' })
  async getModules() {
    return this.prisma.module.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        children: { orderBy: { sortOrder: 'asc' } },
      },
      where: { parentId: null },
    });
  }
}
