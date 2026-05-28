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

import { ProjectDeliverablesService } from './project-deliverables.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { CreateProjectDeliverableDto } from './dto/create-project-deliverable.dto';
import { UpdateProjectDeliverableDto } from './dto/update-project-deliverable.dto';
import { ReorderProjectDeliverablesDto } from './dto/reorder-project-deliverables.dto';

@ApiTags('Project Deliverables')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('project-deliverables')
export class ProjectDeliverablesController {
  constructor(
    private readonly service: ProjectDeliverablesService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'List a project\'s deliverables (ordered)' })
  async findAll(
    @CurrentUser() user: any,
    @Query('projectId', ParseIntPipe) projectId: number,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.findAllForProject(projectId);
  }

  @Post()
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Create a project deliverable' })
  async create(@CurrentUser() user: any, @Body() dto: CreateProjectDeliverableDto) {
    await this.access.assertProjectAccess(user.id, dto.projectId, user.roleId);
    return this.service.create(dto);
  }

  @Post('reorder')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Batch reorder project deliverables' })
  async reorder(@CurrentUser() user: any, @Body() dto: ReorderProjectDeliverablesDto) {
    if (!Array.isArray(dto?.items) || dto.items.length === 0) return { updated: 0 };
    for (const it of dto.items) {
      const projectId = await this.service.getProjectId(it.id);
      await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    }
    return this.service.reorder(dto);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'projects', action: 'write' })
  @ApiOperation({ summary: 'Update a project deliverable (rename/reorder/status)' })
  async update(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDeliverableDto,
  ) {
    const projectId = await this.service.getProjectId(id);
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'projects', action: 'delete' })
  @ApiOperation({ summary: 'Soft delete a project deliverable' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    const projectId = await this.service.getProjectId(id);
    await this.access.assertProjectAccess(user.id, projectId, user.roleId);
    return this.service.remove(id);
  }
}
