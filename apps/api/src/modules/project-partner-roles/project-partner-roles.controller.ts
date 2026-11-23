import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, isAdminUser } from '../../common/guards/roles.guard';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { ProjectPartnerRolesService } from './project-partner-roles.service';

/**
 * Round 4 (2026-11-23): reads need access to the row's project; adding,
 * editing or ending a role changes the team, so it is leader-or-Admin.
 * partners:write alone no longer adds anyone to a project.
 */
@ApiTags('Project Partner Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('project-partner-roles')
export class ProjectPartnerRolesController {
  constructor(
    private readonly service: ProjectPartnerRolesService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get()
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List project-partner-role assignments' })
  async list(
    @CurrentUser() user: any,
    @Query('projectId') projectId?: string,
    @Query('partyId') partyId?: string,
    @Query('roleCode') roleCode?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const pid = projectId ? Number(projectId) : undefined;
    let projectIds: number[] | undefined;
    if (pid) {
      await this.access.assertProjectAccess(user.id, pid, isAdminUser(user));
    } else {
      // No project named: only rows of projects the caller can access.
      const accessible = await this.access.getAccessibleProjectIds(user.id, isAdminUser(user));
      if (!accessible.all) {
        if (accessible.projectIds.length === 0) return [];
        projectIds = accessible.projectIds;
      }
    }
    return this.service.list({
      projectId: pid,
      projectIds,
      partyId: partyId ? Number(partyId) : undefined,
      roleCode: roleCode || undefined,
      activeOnly: activeOnly == null ? true : activeOnly !== 'false',
    });
  }

  /**
   * QA4 Wave-2 TM-1 — feeds the FE Project-Role picker so it lists
   * only roles this party is eligible to hold. Returns
   * `{ eligible, ineligible: [{role, reason}] }`. Bound to `partners:read`
   * because it's a purely-derived view over the project + party's
   * existing partner-roles / job titles.
   */
  @Get('eligible-roles')
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List ProjectRoleTypes split by eligibility for the given party on the given project' })
  async eligibleRoles(
    @CurrentUser() user: any,
    @Query('projectId', ParseIntPipe) projectId: number,
    @Query('partyId', ParseIntPipe) partyId: number,
  ) {
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    return this.service.getEligibleRoles(projectId, partyId);
  }

  @Get(':id')
  @RequirePermissions({ module: 'partners', action: 'read' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    const projectId = await this.service.getProjectId(id);
    await this.access.assertProjectAccess(user.id, projectId, isAdminUser(user));
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions({ module: 'partners', action: 'write' })
  async create(@CurrentUser() user: any, @Body() body: any) {
    const projectId = Number(body?.projectId);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      throw new BadRequestException('projectId is required (positive integer)');
    }
    await this.access.assertProjectManage(user, projectId);
    return this.service.create({ ...body, projectId }, user.id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'partners', action: 'write' })
  async update(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    await this.access.assertProjectManage(user, await this.service.getProjectId(id));
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Soft-end a project-partner-role (sets valid_to=now)' })
  async remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertProjectManage(user, await this.service.getProjectId(id));
    return this.service.remove(id, user.id);
  }
}
