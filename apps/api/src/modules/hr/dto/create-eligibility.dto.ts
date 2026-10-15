import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsDateString, IsOptional, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BucketCreditMode } from '@prisma/client';

/**
 * HR Phase A3 (2026-10-15) — payload for creating a per-employee
 * SpecialHourBucket eligibility. Defaults are applied in the service:
 *   startDate → today (yyyy-mm-dd) when the caller omits it
 *   endDate   → Dec 31 of the current year
 *   dailyAmount → inherited from the bucket when the caller omits it
 */
export class CreateEligibilityDto {
  @ApiProperty({ description: 'SpecialHourBucket.id this eligibility grants.' })
  @IsInt()
  @Type(() => Number)
  bucketId: number;

  @ApiPropertyOptional({ description: 'Daily hours for this employee (defaults to the bucket default when omitted).' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  dailyAmount?: number;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd. Defaults to today.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'ISO date — yyyy-mm-dd. Defaults to Dec 31 of the current calendar year.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ enum: BucketCreditMode, description: 'Per-row override of the bucket defaultCreditMode. null/omit = inherit.' })
  @IsOptional()
  @IsEnum(BucketCreditMode)
  creditMode?: BucketCreditMode;

  @ApiPropertyOptional({ description: 'Attachment file id (nullable INT, no FK in Phase A).' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  documentFileId?: number;
}
