import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ExecutionBoardService } from './execution-board.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Execution Board')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('execution-board')
export class ExecutionBoardController {
  constructor(private readonly service: ExecutionBoardService) {}

  @Get()
  @RequirePermissions({ module: 'projects', action: 'read' })
  @ApiOperation({ summary: 'Get execution board data (zone × phase matrix)' })
  getData(
    @CurrentUser() user: any,
    @Query('projectId') projectId?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    return this.service.getData(
      user.id,
      user.roleId,
      projectId ? +projectId : undefined,
      serviceId ? +serviceId : undefined,
    );
  }
}
