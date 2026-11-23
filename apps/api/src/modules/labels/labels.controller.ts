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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { LabelsService } from './labels.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { AMOUNT_KEYS, canSeeFinance, omitKeys } from '../../common/finance/finance-access';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateLabelDto } from './dto/update-label.dto';

/** Round 4 (2026-11-23): every label route checks access to the label's project. */
@ApiTags('Labels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('labels')
export class LabelsController {
  constructor(
    private readonly labelsService: LabelsService,
    private readonly access: ProjectAccessService,
  ) {}

  private assertProject(user: any, projectId: number): Promise<void> {
    return this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
  }

  private async assertLabel(user: any, labelId: number): Promise<void> {
    await this.assertProject(user, await this.labelsService.getProjectId(labelId));
  }

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a label' })
  async create(@CurrentUser() user: any, @Body() dto: CreateLabelDto) {
    await this.assertProject(user, dto.projectId);
    return this.labelsService.create(dto);
  }

  @Get('tree/:projectId')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get label tree for a project' })
  async getTree(@CurrentUser() user: any, @Param('projectId', ParseIntPipe) projectId: number) {
    await this.assertProject(user, projectId);
    return this.labelsService.getTree(projectId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get a label by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertLabel(user, id);
    const label = await this.labelsService.findOne(id);
    // Permissions round 2 — the label carries its LabelMilestone rows;
    // `amount` (a milestone payment) is stripped for callers without
    // finance:read (ambiguous name, so per endpoint).
    if (canSeeFinance(user) || !Array.isArray((label as any)?.milestones)) return label;
    return { ...label, milestones: omitKeys((label as any).milestones, AMOUNT_KEYS) };
  }

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List labels by project' })
  async findByProject(@CurrentUser() user: any, @Query('projectId', ParseIntPipe) projectId: number) {
    await this.assertProject(user, projectId);
    return this.labelsService.findByProject(projectId);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Update a label' })
  async update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLabelDto) {
    await this.assertLabel(user, id);
    return this.labelsService.update(id, dto);
  }

  @Patch(':id/reorder')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Reorder a label (move to new parent/position)' })
  async reorder(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body('parentId') parentId: number | null,
    @Body('sortOrder') sortOrder: number,
  ) {
    await this.assertLabel(user, id);
    return this.labelsService.reorder(id, parentId, sortOrder);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a label' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.assertLabel(user, id);
    return this.labelsService.remove(id);
  }
}
