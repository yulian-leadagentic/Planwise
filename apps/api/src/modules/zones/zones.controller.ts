import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { ZonesService } from './zones.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';

@ApiTags('Zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('zones')
export class ZonesController {
  constructor(
    private readonly zonesService: ZonesService,
    private readonly access: ProjectAccessService,
  ) {}

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a new zone' })
  async create(@CurrentUser() user: any, @Body() dto: CreateZoneDto) {
    await this.access.assertProjectAccess(user.id, dto.projectId, user.roleId);
    return this.zonesService.create(dto);
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List zones for a project (flat list)' })
  async findAll(@CurrentUser() user: any, @Query('projectId', ParseIntPipe) projectId: number) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.zonesService.findAll(projectId);
  }

  @Get('tree/:projectId')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get zone tree for a project (nested)' })
  async findTree(@CurrentUser() user: any, @Param('projectId', ParseIntPipe) projectId: number) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.zonesService.findTree(projectId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get a single zone' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    return this.zonesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Update a zone' })
  async update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateZoneDto) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    return this.zonesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a zone' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    return this.zonesService.remove(id);
  }

  @Post(':id/copy-structure')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Copy zone structure to a new parent' })
  async copyStructure(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body('newParentId', ParseIntPipe) newParentId: number,
  ) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    await this.access.assertZoneAccess(user.id, newParentId, user.roleId);
    return this.zonesService.copyStructure(id, newParentId);
  }

  @Post(':id/explode-typical')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Explode typical zone into individual zones' })
  async explodeTypical(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    return this.zonesService.explodeTypical(id);
  }

  @Post(':id/apply-task-template')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Apply a task template to a zone' })
  async applyTaskTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body('templateId', ParseIntPipe) templateId: number,
    @CurrentUser() user: any,
  ) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    return this.zonesService.applyTaskTemplate(id, templateId, user.id);
  }

  @Post(':id/duplicate')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Duplicate a zone with its tasks and service types' })
  async duplicateZone(
    @Param('id', ParseIntPipe) id: number,
    @Body('newName') newName: string,
    @CurrentUser() user: any,
  ) {
    await this.access.assertZoneAccess(user.id, id, user.roleId);
    return this.zonesService.duplicateZone(id, newName, user.id);
  }

  @Post('apply-project-template')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Apply a zone or combined template to a project' })
  async applyProjectTemplate(
    @Body() body: { projectId: number; templateId: number; zoneName?: string },
    @CurrentUser() user: any,
  ) {
    await this.access.assertProjectAccess(user.id, body.projectId, user.roleId);
    return this.zonesService.applyProjectTemplate(body.projectId, body.templateId, user.id, body.zoneName);
  }

  @Post('reorder')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Batch reorder zones' })
  async reorder(
    @CurrentUser() user: any,
    @Body() body: { items: { id: number; sortOrder: number; parentId?: number | null }[] },
  ) {
    if (!Array.isArray(body?.items)) return { message: 'no items' };
    for (const item of body.items) {
      await this.access.assertZoneAccess(user.id, item.id, user.roleId);
    }
    return this.zonesService.batchReorder(body.items);
  }
}
