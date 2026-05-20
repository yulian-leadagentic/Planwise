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
   * When the service detects this entry overlaps with another entry on a
   * DIFFERENT task on the same day, it normally rejects with
   * `code: 'CROSS_TASK_OVERLAP'` so the client can show a confirm dialog.
   * The client then retries the same payload with `confirmOverlap: true`
   * to bypass the soft check.
   *
   * SAME-task overlaps are always rejected — no override flag honors them.
   * Reporting twice on the same task for the same minutes would double-
   * count and is treated as a data-entry mistake, not a workflow choice.
   */
  @ApiPropertyOptional({
    description: 'Set to true to acknowledge a cross-task overlap and save anyway',
  })
  @IsOptional()
  @IsBoolean()
  confirmOverlap?: boolean;
}
