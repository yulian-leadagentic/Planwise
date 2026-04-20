import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { PlanningService } from './planning.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProjectAccessService } from '../../common/services/project-access.service';

@ApiTags('Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class PlanningController {
  constructor(
    private readonly planningService: PlanningService,
    private readonly access: ProjectAccessService,
  ) {}

  @Get(':id/planning-data')
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get combined planning data for the planning modal' })
  async getPlanningData(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.access.assertProjectAccess(user.id, id, user.roleId);
    return this.planningService.getPlanningData(id);
  }
}
