import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
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
import { RolesGuard } from '../../common/guards/roles.guard';
import { ProjectPartnerRolesService } from './project-partner-roles.service';

@ApiTags('Project Partner Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('project-partner-roles')
export class ProjectPartnerRolesController {
  constructor(private readonly service: ProjectPartnerRolesService) {}

  @Get()
  @RequirePermissions({ module: 'partners', action: 'read' })
  @ApiOperation({ summary: 'List project-partner-role assignments' })
  list(
    @Query('projectId') projectId?: string,
    @Query('partyId') partyId?: string,
    @Query('roleCode') roleCode?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.service.list({
      projectId: projectId ? Number(projectId) : undefined,
      partyId: partyId ? Number(partyId) : undefined,
      roleCode: roleCode || undefined,
      activeOnly: activeOnly == null ? true : activeOnly !== 'false',
    });
  }

  @Get(':id')
  @RequirePermissions({ module: 'partners', action: 'read' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions({ module: 'partners', action: 'write' })
  create(@CurrentUser() user: any, @Body() body: any) {
    return this.service.create(body, user.id);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'partners', action: 'write' })
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'partners', action: 'delete' })
  @ApiOperation({ summary: 'Soft-end a project-partner-role (sets valid_to=now)' })
  remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id, user.id);
  }
}
