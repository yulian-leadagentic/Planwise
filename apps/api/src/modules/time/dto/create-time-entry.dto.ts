import { IsOptional, IsString, IsInt, IsBoolean, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimeEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  timeClockId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  projectId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  taskId?: number;

  @ApiProperty()
  @IsDateString()
  date: string;

  @ApiPropertyOptional({ description: 'Start time HH:MM' })
  @IsOptional()
  @IsString()
  startTime?: string;

  @ApiPropertyOptional({ description: 'End time HH:MM' })
  @IsOptional()
  @IsString()
  endTime?: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  minutes: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isBillable?: boolean;

  @ApiPropertyOptional({ description: 'Work location: home or office' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ description: 'Task completion percentage after this work' })
  @IsOptional()
  @IsInt()
  completionPct?: number;

  /**
   * @deprecated 2026-06-14 — no-overlap policy is now hard. Cross-task and
   * same-task overlaps both reject with 409 and no flag bypasses them.
   * Field kept on the DTO so existing clients sending it don't get a
   * "property does not exist on type" 400 from `forbidNonWhitelisted: true`.
   * Will be removed after one release cycle.
   */
  @ApiPropertyOptional({
    description: 'Deprecated. Has no effect — overlapping time entries are now hard-rejected.',
    deprecated: true,
  })
  @IsOptional()
  @IsBoolean()
  confirmOverlap?: boolean;
}
