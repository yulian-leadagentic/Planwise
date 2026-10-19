import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HR Phase B3 (2026-10-15) — payload for PATCH /hr/settings. Each
 * field is optional; omitted keys preserve the stored value.
 *
 * HR Wave 2 G2 (2026-10-19) — `shortDayHoursHolidayEve` +
 * `shortDayHoursCholHamoed` removed. Per-day working hours now live
 * on `CalendarDay.workingHours`; the two globals were dropped from
 * `hr_settings` by `20261019010000_hr_working_hours/migration.sql`.
 */
export class UpdateHrSettingsDto {
  @ApiPropertyOptional({ description: 'Minimum hours per working day.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(24)
  @Type(() => Number)
  minHoursPerDay?: number;
}
