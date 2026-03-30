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

@ApiTags('Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class PlanningController {
  constructor(private readonly planningService: PlanningService) {}

  @Get(':id/planning-data')
  @ApiOperation({ summary: 'Get combined planning data for the planning modal' })
  getPlanningData(@Param('id', ParseIntPipe) id: number) {
    return this.planningService.getPlanningData(id);
  }
}
