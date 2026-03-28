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

import { TimeEntriesService } from './time-entries.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';

@ApiTags('Time Entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('time-entries')
export class TimeEntriesController {
  constructor(private readonly timeEntriesService: TimeEntriesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a time entry' })
  create(@CurrentUser() user: any, @Body() dto: CreateTimeEntryDto) {
    return this.timeEntriesService.create(user.id, dto);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Create multiple time entries at once' })
  batchCreate(@CurrentUser() user: any, @Body('entries') entries: CreateTimeEntryDto[]) {
    return this.timeEntriesService.batchCreate(user.id, entries);
  }

  @Get('daily')
  @ApiOperation({ summary: 'Get daily breakdown of time entries' })
  getDailyBreakdown(
    @CurrentUser() user: any,
    @Query('date') date: string,
    @Query('userId') userId?: number,
  ) {
    return this.timeEntriesService.getDailyBreakdown(userId ?? user.id, date);
  }

  @Get('weekly')
  @ApiOperation({ summary: 'Get weekly grid of time entries' })
  getWeeklyGrid(
    @CurrentUser() user: any,
    @Query('weekStart') weekStart: string,
    @Query('userId') userId?: number,
  ) {
    return this.timeEntriesService.getWeeklyGrid(userId ?? user.id, weekStart);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a time entry by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.timeEntriesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a time entry' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateTimeEntryDto>) {
    return this.timeEntriesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a time entry' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.timeEntriesService.remove(id);
  }
}
