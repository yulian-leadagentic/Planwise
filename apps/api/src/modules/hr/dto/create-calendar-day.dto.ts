import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarDayAppliesTo, CalendarDayType } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
