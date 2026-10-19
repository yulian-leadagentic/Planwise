import { ApiPropertyOptional } from '@nestjs/swagger';
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

export class UpdateHrCalendarDayDto {
  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd.' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ enum: ['HOLIDAY', 'HOLIDAY_EVE', 'CHOL_HAMOED', 'REST'] })
  @IsOptional()
  @IsIn(['HOLIDAY', 'HOLIDAY_EVE', 'CHOL_HAMOED', 'REST'] as const)
  type?: Exclude<CalendarDayType, 'REGULAR'>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: CalendarDayAppliesTo })
  @IsOptional()
  @IsEnum(CalendarDayAppliesTo)
  appliesTo?: CalendarDayAppliesTo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  halfDayUntil?: string | null;

  /**
   * HR Wave 2 G2 (2026-10-19) — per-day working hours override. An
   * explicit `null` clears the row back to the type default; an
   * omitted key preserves the stored value.
   */
  @ApiPropertyOptional({ description: 'Working hours on this day; null = use type default.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  @Type(() => Number)
  workingHours?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
