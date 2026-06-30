import { PartialType } from '@nestjs/mapped-types';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsBoolean, IsInt, IsString, IsDateString, Min, Max, ValidateIf } from 'class-validator';

import { CreateTaskDto } from './create-task.dto';

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  completionPct?: number;

  // The three date fields must accept BOTH a valid date string AND `null`
  // (the explicit "clear this date" signal). class-validator's @IsOptional
  // skips downstream validators on null/undefined, BUT class-transformer
  // (transform: true on the global pipe) was silently stripping nulls on
  // fields typed as plain `string` — clearing the due date appeared to
  // succeed but the value never reached the service. Declaring the field
  // as `string | null` plus @ValidateIf to skip @IsDateString on null
  // makes both intent and runtime behavior unambiguous.

  /** Planning forecast — when work is *expected* to begin. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  estimatedStartDate?: string | null;

  /** Actual start — when work physically began. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  startDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
