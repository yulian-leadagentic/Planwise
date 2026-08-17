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
import { RequirePermissions, OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';

@ApiTags('Time Entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('time-entries')
export class TimeEntriesController {
  constructor(private readonly timeEntriesService: TimeEntriesService) {}

  @Post()
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Create a time entry' })
  create(@CurrentUser() user: any, @Body() dto: CreateTimeEntryDto) {
    return this.timeEntriesService.create(user.id, dto);
  }

  @Post('batch')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Create multiple time entries at once' })
  batchCreate(@CurrentUser() user: any, @Body('entries') entries: CreateTimeEntryDto[]) {
    return this.timeEntriesService.batchCreate(user.id, entries);
  }

  /**
   * List time entries for the current user, optionally filtered by task,
   * project, or a specific date. Used by:
   *   • Task drawer "Time" tab — `?taskId=N` to show history for one task
   *   • QuickTimeLog inline form (kanban card + list view) — same usage
   *   • My-Tasks list view "Today's entries" block — `?date=YYYY-MM-DD`
   *
   * Without filters it returns the caller's most recent entries (capped) so
   * the route is safe to hit blind. Always scoped to `user.id` server-side
   * — query params can't escape that.
   */
  @Get()
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'List time entries for the current user' })
  list(
    @CurrentUser() user: any,
    @Query('taskId') taskId?: string,
    @Query('projectId') projectId?: string,
    @Query('date') date?: string,
  ) {
    const taskIdNum = taskId != null && taskId !== '' ? Number(taskId) : undefined;
    const projectIdNum = projectId != null && projectId !== '' ? Number(projectId) : undefined;
    return this.timeEntriesService.listForUser(user.id, {
      taskId: Number.isFinite(taskIdNum) ? taskIdNum : undefined,
      projectId: Number.isFinite(projectIdNum) ? projectIdNum : undefined,
      date,
    });
  }

  @Get('daily')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Get daily breakdown of time entries' })
  getDailyBreakdown(
    @CurrentUser() user: any,
    @Query('date') date: string,
    @Query('userId') userId?: number,
  ) {
    // Use Number.isFinite — NestJS implicit conversion turns a missing
    // optional ?userId= query param into NaN (Number(undefined)), and `??`
    // doesn't catch NaN, so the fallback to user.id was never picked up.
    const effectiveUserId = Number.isFinite(userId) ? (userId as number) : user.id;
    return this.timeEntriesService.getDailyBreakdown(effectiveUserId, date);
  }

  @Get('weekly')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Get weekly grid of time entries' })
  getWeeklyGrid(
    @CurrentUser() user: any,
    @Query('weekStart') weekStart: string,
    @Query('userId') userId?: number,
  ) {
    // Same NaN-from-implicit-conversion gotcha as getDailyBreakdown above.
    const effectiveUserId = Number.isFinite(userId) ? (userId as number) : user.id;
    return this.timeEntriesService.getWeeklyGrid(effectiveUserId, weekStart);
  }

  @Get(':id')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Get a time entry by ID' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.timeEntriesService.findOne(id);
  }

  @Patch(':id')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Update a time entry' })
  update(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateTimeEntryDto>,
  ) {
    return this.timeEntriesService.update(id, dto, user.id);
  }

  @Delete(':id')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'delete' })
  @ApiOperation({ summary: 'Delete a time entry' })
  remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.timeEntriesService.remove(id, user.id);
  }
}
