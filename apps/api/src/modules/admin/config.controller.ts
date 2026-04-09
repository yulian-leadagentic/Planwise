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
  Req,
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
  async createProjectType(@Body() body: { name: string; code?: string; color?: string }) {
    return this.prisma.projectType.create({ data: { name: body.name, code: body.code || null, color: body.color || null } });
  }

  @Patch('project-types/:id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update project type' })
  async updateProjectType(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name?: string; code?: string; color?: string },
  ) {
    return this.prisma.projectType.update({
      where: { id },
      data: { name: body.name, code: body.code, color: body.color },
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

  // Team Templates
  @Get('team-templates')
  @RequirePermissions({ module: 'admin', action: 'read' })
  async getTeamTemplates() {
    return this.prisma.teamTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, firstName: true, lastName: true } },
        members: {
          include: { user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, userType: true, position: true } } },
        },
        _count: { select: { members: true } },
      },
    });
  }

  @Post('team-templates')
  @RequirePermissions({ module: 'admin', action: 'write' })
  async createTeamTemplate(@Body() body: { name: string }, @Req() req: any) {
    return this.prisma.teamTemplate.create({
      data: { name: body.name, createdBy: req.user?.id || 1 },
      include: { members: { include: { user: true } }, _count: { select: { members: true } } },
    });
  }

  @Delete('team-templates/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  async deleteTeamTemplate(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.teamTemplateMember.deleteMany({ where: { teamTemplateId: id } });
    await this.prisma.teamTemplate.delete({ where: { id } });
    return { message: 'Team template deleted' };
  }

  @Post('team-templates/:id/members')
  @RequirePermissions({ module: 'admin', action: 'write' })
  async addTeamTemplateMember(
    @Param('id', ParseIntPipe) templateId: number,
    @Body() body: { userId: number; role?: string },
  ) {
    return this.prisma.teamTemplateMember.create({
      data: { teamTemplateId: templateId, userId: body.userId, role: body.role || null },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, userType: true } } },
    });
  }

  @Delete('team-template-members/:id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  async removeTeamTemplateMember(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.teamTemplateMember.delete({ where: { id } });
    return { message: 'Member removed' };
  }
}
