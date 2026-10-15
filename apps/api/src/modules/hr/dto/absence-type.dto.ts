import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AbsenceUnit } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HR Phase B3 (2026-10-15) — POST /hr/absence-types. `isSystem` is
 * fixed to false server-side (system rows live in the seed only).
 */
export class CreateAbsenceTypeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  code: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  nameHe: string;

  @ApiProperty({ enum: AbsenceUnit })
  @IsEnum(AbsenceUnit)
  unit: AbsenceUnit;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresDocument?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  deductsFromSick?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxPerYear?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

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

/**
 * PATCH /hr/absence-types/:id. The service strips the Q10-locked
 * fields when the row is a seeded `isSystem` entry; otherwise all
 * fields flow through.
 */
export class UpdateAbsenceTypeDto {
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
  @IsBoolean()
  deductsFromSick?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxPerYear?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

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
