import { ApiPropertyOptional } from '@nestjs/swagger';
import { CalendarDayAppliesTo, CalendarDayType } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
