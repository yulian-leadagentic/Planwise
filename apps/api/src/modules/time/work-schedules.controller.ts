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

import { WorkSchedulesService } from './work-schedules.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CreateWorkScheduleDto } from './dto/create-work-schedule.dto';

@ApiTags('Work Schedules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('work-schedules')
export class WorkSchedulesController {
  constructor(private readonly workSchedulesService: WorkSchedulesService) {}

  @Post()
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Create a work schedule' })
  create(@Body() dto: CreateWorkScheduleDto) {
    return this.workSchedulesService.create(dto);
  }

  @Get()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Get work schedules for a user' })
  findByUser(@Query('userId', ParseIntPipe) userId: number) {
    return this.workSchedulesService.findByUser(userId);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Update a work schedule' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateWorkScheduleDto>) {
    return this.workSchedulesService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'time', action: 'delete' })
  @ApiOperation({ summary: 'Delete a work schedule' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.workSchedulesService.remove(id);
  }
}
