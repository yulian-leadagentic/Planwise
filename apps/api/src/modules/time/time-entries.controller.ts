import {
  BadRequestException,
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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';

import { TimeEntriesService } from './time-entries.service';
import { HrMonthlyService } from '../hr/hr-monthly.service';
import {
  EmployeeScopeService,
  notInManagerChain,
  toLeaderView,
} from '../../common/services/employee-scope.service';
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
  constructor(
    private readonly timeEntriesService: TimeEntriesService,
    private readonly monthly: HrMonthlyService,
    private readonly employeeScope: EmployeeScopeService,
  ) {}

  /**
   * Round 3 (2026-11-22) — `?userId=` of someone else needs
   * EmployeeScopeService.canViewEmployee (self / hr:read / manager
   * chain). Admin gets no exception. Returns the user id to read.
   *
   * `Number.isFinite`: NestJS implicit conversion turns a missing
   * optional ?userId= into NaN, and `??` doesn't catch NaN.
   */
  private async resolveViewedUser(user: any, userId?: number | string): Promise<number> {
    const asNumber = userId == null || userId === '' ? NaN : Number(userId);
    const target = Number.isFinite(asNumber) ? asNumber : user.id;
    if (target !== user.id) {
      await this.employeeScope.assertCanViewEmployee(user, target, 'attendance and time entries');
    }
    return target;
  }

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

  /**
   * HR Phase C3 — self-service monthly summary. Authenticated only
   * (NO `hr:*` guard — this is the caller's own numbers). Scopes to
   * `user.id` server-side; a query param can't broaden the scope.
   * Returns:
   *   • row: computed MonthlyAttendance snapshot (DRAFT if no row has
   *     been written yet — the endpoint never writes).
   *   • dailyBreakdown: day-by-day engine output.
   *   • monthlyAbsences: the caller's absences in-month.
   *   • cBucketUsage: per C-bucket YTD used / maxPerYear for the bars.
   */
  @Get('my-monthly-summary')
  @ApiOperation({ summary: 'Caller-scoped monthly summary (DRAFT if not yet recomputed).' })
  @ApiQuery({ name: 'year', required: true, type: Number })
  @ApiQuery({ name: 'month', required: true, type: Number })
  getMyMonthlySummary(
    @CurrentUser() user: any,
    @Query('year') yearRaw: string,
    @Query('month') monthRaw: string,
  ) {
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      throw new BadRequestException('year and month are required integers (month 1-12)');
    }
    return this.monthly.getMySummary(user.id, year, month);
  }

  /**
   * `?weekStart=YYYY-MM-DD` → the 7-day `DailyBreakdown[]` the My Time
   * page renders (clock record, expected shift, entries, difference per
   * day). `?date=YYYY-MM-DD` → the single-day breakdown (entries +
   * summary). The web always sends `weekStart`; `date` stays for API
   * clients. Another user's breakdown needs canViewEmployee.
   */
  @Get('daily')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Daily breakdown: ?weekStart= (7 days, with clock data) or ?date= (one day)' })
  async getDailyBreakdown(
    @CurrentUser() user: any,
    @Query('date') date?: string,
    @Query('userId') userId?: number,
    @Query('weekStart') weekStart?: string,
  ) {
    if (!weekStart && !date) {
      throw new BadRequestException('weekStart or date is required (YYYY-MM-DD)');
    }
    const effectiveUserId = await this.resolveViewedUser(user, userId);
    if (weekStart) return this.timeEntriesService.getWeekDailyBreakdown(effectiveUserId, weekStart);
    return this.timeEntriesService.getDailyBreakdown(effectiveUserId, date as string);
  }

  /**
   * The shared `WeeklyGrid` shape (rows with 7 day cells, clock,
   * dailyTotals, weekSummary). `?projectId=` narrows the rows and the
   * logged totals (the Weekly Grid page's project filter). Another
   * user's grid needs canViewEmployee.
   */
  @Get('weekly')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Weekly grid of time entries (shared WeeklyGrid shape)' })
  async getWeeklyGrid(
    @CurrentUser() user: any,
    @Query('weekStart') weekStart: string,
    @Query('userId') userId?: number,
    @Query('projectId') projectId?: number | string,
  ) {
    const effectiveUserId = await this.resolveViewedUser(user, userId);
    const project = projectId == null || projectId === '' ? NaN : Number(projectId);
    return this.timeEntriesService.getWeeklyGrid(
      effectiveUserId,
      weekStart,
      Number.isFinite(project) ? { projectId: project } : {},
    );
  }

  /**
   * Round 3 (2026-11-22) — the owner; anyone who may view the employee
   * (hr:read / manager chain); or the leader of the entry's project,
   * who gets the leader view (no location, special-hours bucket or
   * clock data — see toLeaderView). Everyone else: 403.
   */
  @Get(':id')
  @OwnData()
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Get a time entry by ID' })
  async findOne(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    const entry = await this.timeEntriesService.findOne(id);
    if (entry.userId === user.id) return entry;
    if (await this.employeeScope.canViewEmployee(user, entry.userId)) return entry;
    const projectId = entry.projectId ?? entry.task?.projectId ?? null;
    if (await this.employeeScope.isProjectLeader(user.id, projectId)) return toLeaderView(entry);
    throw notInManagerChain('time entries');
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
