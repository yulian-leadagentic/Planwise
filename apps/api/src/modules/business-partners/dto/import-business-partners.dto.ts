import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class ImportBusinessPartnersDto {
  /**
   * If true, rows whose email already exists are SKIPPED.
   * If false (default) → such rows are reported as errors.
   * Either way, no existing row is overwritten.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  skipExisting?: boolean = false;

  /**
   * If true, parse + validate but do NOT write rows. Returns a preview of
   * what would happen (counts + errors). Use this to dry-run an import.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  dryRun?: boolean = false;
}
