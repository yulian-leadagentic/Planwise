import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * HR Phase D1 rework (2026-10-18, §13) — the consolidated report is now
 * a GET with query params: `?year&month&userIds?`. There is no scope
 * discriminator anymore ("all-active" is the default; "manual" collapses
 * into "userIds was supplied"; "org-unit" was dropped — the FE multi-
 * select on `/hr/reports` handles subtree selection by hand).
 *
 * `userIds` is a CSV string on the wire (easier to shape in a URL) and
 * the controller parses it into `number[]`. We validate the raw CSV
 * shape here; the controller does the final int-parse.
 */
export class ConsolidatedReportQueryDto {
  @ApiProperty({ example: 2026, description: 'Full year (yyyy)' })
  @IsInt()
  @Min(2000)
  @Max(2100)
  @Type(() => Number)
  year!: number;

  @ApiProperty({ example: 10, description: 'Calendar month (1-12)' })
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month!: number;

  @ApiPropertyOptional({
    example: '3,7,11',
    description:
      'Optional comma-separated list of user ids. Omit for every active employee.',
  })
  @IsOptional()
  @IsString()
  userIds?: string;
}

/**
 * Export variant adds the required `format` (xlsx|pdf). The controller
 * rejects anything else with 400.
 */
export class ConsolidatedReportExportQueryDto extends ConsolidatedReportQueryDto {
  @ApiProperty({ example: 'xlsx', enum: ['xlsx', 'pdf'] })
  @IsString()
  format!: 'xlsx' | 'pdf';
}
