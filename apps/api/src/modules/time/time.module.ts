import { Module } from '@nestjs/common';
import { TimeClockController } from './time-clock.controller';
import { TimeClockService } from './time-clock.service';
import { TimeEntriesController } from './time-entries.controller';
import { TimeEntriesService } from './time-entries.service';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  controllers: [
    TimeClockController,
    TimeEntriesController,
    WorkSchedulesController,
    CalendarController,
  ],
  providers: [
    TimeClockService,
    TimeEntriesService,
    WorkSchedulesService,
    CalendarService,
  ],
  exports: [TimeClockService, TimeEntriesService],
})
export class TimeModule {}
