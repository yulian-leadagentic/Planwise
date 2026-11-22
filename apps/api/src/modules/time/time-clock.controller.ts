import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

import { TimeClockService } from './time-clock.service';
import { EmployeeScopeService } from '../../common/services/employee-scope.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions, OwnData } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClockInDto } from './dto/clock-in.dto';
import { ClockOutDto } from './dto/clock-out.dto';

@ApiTags('Time Clock')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('time-clock')
export class TimeClockController {
  constructor(
    private readonly timeClockService: TimeClockService,
    private readonly employeeScope: EmployeeScopeService,
  ) {}

  @Post('clock-in')
  @OwnData()
  @ApiOperation({ summary: 'Clock in for the day' })
  clockIn(@CurrentUser() user: any, @Body() dto: ClockInDto) {
    return this.timeClockService.clockIn(user.id, dto);
  }

  @Post('clock-out')
  @OwnData()
  @ApiOperation({ summary: 'Clock out for the day' })
  clockOut(@CurrentUser() user: any, @Body() dto: ClockOutDto) {
    return this.timeClockService.clockOut(user.id, dto);
  }

  @Get('status')
  @OwnData()
  @ApiOperation({ summary: 'Get current clock status' })
  getStatus(@CurrentUser() user: any) {
    return this.timeClockService.getStatus(user.id);
  }

  @Get('today')
  @OwnData()
  @ApiOperation({ summary: 'Get today dashboard data' })
  getDashboardToday(@CurrentUser() user: any) {
    return this.timeClockService.getDashboardToday(user.id);
  }

  // Team-wide today view for /time/clock-dashboard + /admin/clock-dashboard.
  // Distinct from /today (which returns the caller's own record).
  // Round 3 (2026-11-22): only the people the caller may see — everyone
  // for hr:read, else himself + the employees he manages (an Admin
  // without hr included).
  @Get('team-today')
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Attendance overview for today — employees the caller may see' })
  async getTeamDashboardToday(@CurrentUser() user: any) {
    const visible = await this.employeeScope.visibleUserIds(user);
    return this.timeClockService.getTeamDashboardToday(visible, user.id);
  }

  // Round 3: without userId → every visible user; with userId →
  // canViewEmployee (self / hr:read / manager chain) or 403.
  @Get('history')
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Clock history — one user (if visible) or every visible user' })
  async getHistory(
    @CurrentUser() user: any,
    @Query('userId') userId: number | string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const target = userId == null || userId === '' ? NaN : Number(userId);
    if (Number.isFinite(target)) {
      await this.employeeScope.assertCanViewEmployee(user, target, 'attendance');
      return this.timeClockService.getHistory(target, from, to);
    }
    const visible = await this.employeeScope.visibleUserIds(user);
    return this.timeClockService.getHistory(null, from, to, visible);
  }

  // Round 3 (2026-11-22) — edit / approve / mark-absent. The service is
  // the source of truth (hr:write / hr:approve or the manager chain,
  // never one's own record). The route gate is only the baseline every
  // seeded role holds (time:read) so a manager with just the Employee
  // or Manager preset is not locked out of his own team.
  @Patch(':id/edit')
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: "Edit an employee's clock record (HR or the employee's manager chain)" })
  edit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.timeClockService.editRecord(id, user, body);
  }

  @Patch(':id/approve')
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: "Approve an employee's clock record (HR or the manager chain; never your own)" })
  approve(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.timeClockService.approveRecord(id, user);
  }

  @Post('mark-absent')
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Mark an employee as absent (HR or the manager chain)' })
  markAbsent(
    @CurrentUser() user: any,
    @Body('userId', ParseIntPipe) userId: number,
    @Body('date') date: string,
    @Body('note') note?: string,
  ) {
    return this.timeClockService.markAbsent(user, userId, date, note);
  }
}
