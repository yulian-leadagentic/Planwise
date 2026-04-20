import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  UserType,
  ProjectStatus,
  TaskStatus,
  TaskPriority,
  CalendarDayType,
  CalendarDayAppliesTo,
  TimeClockStatus,
  ClockType,
  ContractStatus,
  BillingType,
  BillingStatus,
  ExpenseType,
  ActivityCategory,
  ActivitySeverity,
} from '@prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OwnData } from '../../common/decorators/roles.decorator';

@ApiTags('Admin - Enums')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@OwnData()
@Controller('enums')
export class EnumsController {
  @Get()
  @ApiOperation({ summary: 'Get all enum values used in the system' })
  getEnums() {
    return {
      UserType: Object.values(UserType),
      ProjectStatus: Object.values(ProjectStatus),
      TaskStatus: Object.values(TaskStatus),
      TaskPriority: Object.values(TaskPriority),
      CalendarDayType: Object.values(CalendarDayType),
      CalendarDayAppliesTo: Object.values(CalendarDayAppliesTo),
      TimeClockStatus: Object.values(TimeClockStatus),
      ClockType: Object.values(ClockType),
      ContractStatus: Object.values(ContractStatus),
      BillingType: Object.values(BillingType),
      BillingStatus: Object.values(BillingStatus),
      ExpenseType: Object.values(ExpenseType),
      ActivityCategory: Object.values(ActivityCategory),
      ActivitySeverity: Object.values(ActivitySeverity),
    };
  }
}
