import { IsString, IsOptional, IsEnum, IsBoolean, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
