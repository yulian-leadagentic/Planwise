import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AbsenceUnit, BucketBehavior, BucketCreditMode } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HR Phase B3 (2026-10-15) — admin CRUD for SpecialHourBucket. New
 * rows always land as non-system; the service enforces the Q10 lock
 * on system rows during PATCH.
 */
export class CreateSpecialHourBucketDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  code: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  nameHe: string;

  @ApiProperty({ enum: BucketBehavior })
  @IsEnum(BucketBehavior)
  behavior: BucketBehavior;

  @ApiProperty({ enum: AbsenceUnit })
  @IsEnum(AbsenceUnit)
  unit: AbsenceUnit;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @ApiPropertyOptional({ description: 'Daily default amount (behavior B).' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  dailyAmount?: number | null;

  @ApiPropertyOptional({ description: 'Annual cap (behavior C or A).' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxPerYear?: number | null;

  @ApiPropertyOptional({ description: 'Minimum daily standard required for eligibility.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minDailyStandard?: number | null;

  @ApiPropertyOptional({ enum: BucketCreditMode, default: 'REPORTED' })
  @IsOptional()
  @IsEnum(BucketCreditMode)
  defaultCreditMode?: BucketCreditMode;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}

export class UpdateSpecialHourBucketDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nameHe?: string;

  @ApiPropertyOptional({ enum: BucketBehavior })
  @IsOptional()
  @IsEnum(BucketBehavior)
  behavior?: BucketBehavior;

  @ApiPropertyOptional({ enum: AbsenceUnit })
  @IsOptional()
  @IsEnum(AbsenceUnit)
  unit?: AbsenceUnit;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  dailyAmount?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxPerYear?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minDailyStandard?: number | null;

  @ApiPropertyOptional({ enum: BucketCreditMode })
  @IsOptional()
  @IsEnum(BucketCreditMode)
  defaultCreditMode?: BucketCreditMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}
