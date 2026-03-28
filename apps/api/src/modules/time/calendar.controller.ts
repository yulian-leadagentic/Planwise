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

import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateCalendarDayDto } from './dto/create-calendar-day.dto';

@ApiTags('Calendar')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Post()
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Create a calendar day' })
  create(@CurrentUser() user: any, @Body() dto: CreateCalendarDayDto) {
    return this.calendarService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get calendar days for a date range' })
  findAll(@Query('from') from: string, @Query('to') to: string) {
    return this.calendarService.findAll(from, to);
  }

  @Patch(':id')
  @RequirePermissions({ module: 'admin', action: 'write' })
  @ApiOperation({ summary: 'Update a calendar day' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateCalendarDayDto>) {
    return this.calendarService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions({ module: 'admin', action: 'delete' })
  @ApiOperation({ summary: 'Delete a calendar day' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.calendarService.remove(id);
  }
}
