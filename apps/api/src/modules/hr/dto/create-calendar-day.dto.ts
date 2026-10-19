import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarDayAppliesTo, CalendarDayType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * HR Phase B3 (2026-10-15) — payload for the admin CRUD routes under
 * /hr/calendar-days. REGULAR days are never materialised — the service
 * rejects a REGULAR body with a 400 (the time/attendance engine
 * defaults missing dates to REGULAR implicitly).
 */
export class CreateHrCalendarDayDto {
  @ApiProperty({ description: 'ISO date — yyyy-mm-dd.' })
  @IsDateString()
  date: string;

  @ApiProperty({ enum: ['HOLIDAY', 'HOLIDAY_EVE', 'CHOL_HAMOED', 'REST'] })
  @IsIn(['HOLIDAY', 'HOLIDAY_EVE', 'CHOL_HAMOED', 'REST'] as const)
  type: Exclude<CalendarDayType, 'REGULAR'>;

  @ApiProperty({ description: 'Human-visible label (Hebrew allowed).' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ enum: CalendarDayAppliesTo, default: 'all' })
  @IsOptional()
  @IsEnum(CalendarDayAppliesTo)
  appliesTo?: CalendarDayAppliesTo;

  @ApiPropertyOptional({ description: 'HH:MM — half-day ends at this clock-time.' })
  @IsOptional()
  @IsString()
  halfDayUntil?: string;

  /**
   * HR Wave 2 G2 (2026-10-19) — per-day working hours. Null / omitted
   * = fall back to the type default on the server (0 for HOLIDAY /
   * REST, 5 for HOLIDAY_EVE / CHOL_HAMOED). `CalendarDay` is global,
   * so there is no per-user dailyStandardHours cap — [0, 24] with up
   * to 2 decimals (DECIMAL(4,2) truncates past that).
   */
  @ApiPropertyOptional({ description: 'Working hours on this day; null = use type default.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  @Type(() => Number)
  workingHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
