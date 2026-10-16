import { Module } from '@nestjs/common';
import { TimeClockController } from './time-clock.controller';
import { TimeClockService } from './time-clock.service';
import { TimeEntriesController } from './time-entries.controller';
import { TimeEntriesService } from './time-entries.service';
import { WorkSchedulesController } from './work-schedules.controller';
import { WorkSchedulesService } from './work-schedules.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { HrModule } from '../hr/hr.module';

/**
 * HR Phase C3 (2026-10-16) — HrModule is imported so
 * TimeEntriesController can inject `HrMonthlyService` for the
 * self-service `/time-entries/my-monthly-summary` endpoint. The HR
 * module exports only the engine service (not the full catalog
 * surface), so there is no permission bleed into Time.
 */
@Module({
  imports: [HrModule],
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
