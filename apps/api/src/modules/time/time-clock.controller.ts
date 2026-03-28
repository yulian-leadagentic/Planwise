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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClockInDto } from './dto/clock-in.dto';
import { ClockOutDto } from './dto/clock-out.dto';

@ApiTags('Time Clock')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('time-clock')
export class TimeClockController {
  constructor(private readonly timeClockService: TimeClockService) {}

  @Post('clock-in')
  @ApiOperation({ summary: 'Clock in for the day' })
  clockIn(@CurrentUser() user: any, @Body() dto: ClockInDto) {
    return this.timeClockService.clockIn(user.id, dto);
  }

  @Post('clock-out')
  @ApiOperation({ summary: 'Clock out for the day' })
  clockOut(@CurrentUser() user: any, @Body() dto: ClockOutDto) {
    return this.timeClockService.clockOut(user.id, dto);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current clock status' })
  getStatus(@CurrentUser() user: any) {
    return this.timeClockService.getStatus(user.id);
  }

  @Get('today')
  @ApiOperation({ summary: 'Get today dashboard data' })
  getDashboardToday(@CurrentUser() user: any) {
    return this.timeClockService.getDashboardToday(user.id);
  }

  @Get('history')
  @RequirePermissions({ module: 'time', action: 'read' })
  @ApiOperation({ summary: 'Get clock history for user' })
  getHistory(
    @Query('userId') userId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.timeClockService.getHistory(userId, from, to);
  }

  @Patch(':id/edit')
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Edit a time clock record (admin)' })
  edit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.timeClockService.editRecord(id, user.id, body);
  }

  @Patch(':id/approve')
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Approve a time clock record' })
  approve(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.timeClockService.approveRecord(id, user.id);
  }

  @Post('mark-absent')
  @RequirePermissions({ module: 'time', action: 'write' })
  @ApiOperation({ summary: 'Mark a user as absent' })
  markAbsent(
    @Body('userId', ParseIntPipe) userId: number,
    @Body('date') date: string,
    @Body('note') note?: string,
  ) {
    return this.timeClockService.markAbsent(userId, date, note);
  }
}
