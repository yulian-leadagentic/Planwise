import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsDateString, IsOptional, IsEnum, IsBoolean, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BucketCreditMode } from '@prisma/client';

/**
 * HR Phase A3 (2026-10-15) — partial update to an existing eligibility.
 * `active` is included so the HR drawer can soft-delete a row via
 * PATCH { active: false } in addition to the DELETE endpoint (both
 * paths converge on the same service method).
 */
export class UpdateEligibilityDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  dailyAmount?: number;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: BucketCreditMode })
  @IsOptional()
  @IsEnum(BucketCreditMode)
  creditMode?: BucketCreditMode | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  documentFileId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
