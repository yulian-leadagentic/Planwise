import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CalendarDayType, CalendarDayAppliesTo } from '@prisma/client';

export class CreateCalendarDayDto {
  @ApiProperty()
  @IsDateString()
  date: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ enum: CalendarDayType })
  @IsEnum(CalendarDayType)
  type: CalendarDayType;

  @ApiPropertyOptional({ example: '12:00' })
  @IsOptional()
  @IsString()
  halfDayUntil?: string;

  /**
   * HR Wave 2 G2 (2026-10-19) — per-day working hours. Null / omitted
   * = type-default fallback on the server. [0, 24] with up to 2
   * decimals (DECIMAL(4,2) truncates past that).
   */
  @ApiPropertyOptional({ description: 'Working hours on this day; null = use type default.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  @Type(() => Number)
  workingHours?: number | null;

  @ApiPropertyOptional({ enum: CalendarDayAppliesTo })
  @IsOptional()
  @IsEnum(CalendarDayAppliesTo)
  appliesTo?: CalendarDayAppliesTo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
