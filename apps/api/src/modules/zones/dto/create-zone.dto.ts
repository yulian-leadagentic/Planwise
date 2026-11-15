import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsBoolean,
  IsIn,
  MinLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ZoneType } from '@prisma/client';

/**
 * §12 (2026-11-14) · `zoneType` validation.
 *
 * `POST /zones` answered 500 for an unknown `zoneType`: the DTO only
 * checked "is a string", the value went to Prisma as-is, and Prisma
 * rejects anything outside the `ZoneType` enum with a client validation
 * error — which is not an HttpException. The same hole was open on
 * `PATCH /zones/:id` (UpdateZoneDto derives from this class).
 *
 * Allowed set = the Prisma enum (`site` / `building` / `level` / `wing`)
 * — the only values the column can hold since 20261011010000 dropped the
 * legacy members.
 *
 * The four LEGACY codes are still accepted on input and normalised with
 * the approved ZT-3 mapping (the one `remap-legacy-zone-codes` applied
 * to every stored row), because the web still sends one: both Add-Zone
 * forms in the planning modal start on `'zone'` (rendered as
 * "Zone (legacy)") and post it unless the user picks another type.
 * Rejecting it would turn that default flow from a 500 into a 400;
 * mapping it gives the zone the type a legacy row was migrated to
 * (`zone` → `building`, which is also the column default).
 *
 * Anything else is a 400 from the global ValidationPipe naming the
 * allowed values.
 */
export const ZONE_TYPE_VALUES: ZoneType[] = Object.values(ZoneType);

/** ZT-3 mapping (approved 2026-10-08) — keep in step with
 *  `BackfillsController.runRemapLegacyZoneCodes`. */
export const LEGACY_ZONE_TYPE_MAP: Readonly<Record<string, ZoneType>> = {
  floor: ZoneType.level,
  area: ZoneType.site,
  zone: ZoneType.building,
  section: ZoneType.wing,
};

/**
 * Canonical form of an incoming `zoneType`: trimmed, lower-cased (the
 * backfill matched legacy codes case-insensitively too), legacy codes
 * mapped. `null` / empty mean "not provided" — create falls back to the
 * column default and update leaves the type alone, as both did before.
 * Non-strings and unknown codes pass through untouched for `@IsIn` to
 * reject.
 */
export function normalizeZoneType(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  const code = value.trim().toLowerCase();
  if (code === '') return undefined;
  return LEGACY_ZONE_TYPE_MAP[code] ?? code;
}

export class CreateZoneDto {
  @ApiProperty()
  @IsInt()
  projectId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  parentId?: number;

  @ApiPropertyOptional({ enum: ZONE_TYPE_VALUES })
  @Transform(({ value }) => normalizeZoneType(value))
  @IsOptional()
  @IsIn(ZONE_TYPE_VALUES, {
    message: `zoneType must be one of: ${ZONE_TYPE_VALUES.join(', ')}`,
  })
  zoneType?: ZoneType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  areaSqm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isTypical?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  typicalCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
