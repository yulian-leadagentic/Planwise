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
  async createProjectType(@Body() body: { name: string; code?: string }) {
    return this.prisma.projectType.create({ data: { name: body.name, code: body.code || null } });
  }

  @Patch('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update project type' })
  async updateProjectType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; code?: string },
  ) {
    return this.prisma.projectType.update({
      where: { id },
      data: { name: body.name, code: body.code },
    });
  }

  @Delete('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete project type' })
  async deleteProjectType(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.projectType.delete({ where: { id } });
    return { message: 'Project type deleted' };
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
