import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HR Phase C3 (2026-10-16) — recompute batch payload.
 *
 * `userIds` is optional: when omitted, the controller resolves it to
 * every active employee server-side (so the FE doesn't need the
 * roster upfront). When supplied, it must be a non-empty unique
 * integer list.
 */
export class RecomputeMonthDto {
  @ApiProperty({ example: 2026, description: 'Full year (yyyy)' })
  @IsInt()
  @Min(2000)
  @Max(3000)
  @Type(() => Number)
  year!: number;

  @ApiProperty({ example: 10, description: 'Calendar month (1-12)' })
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month!: number;

  @ApiPropertyOptional({
    type: [Number],
    description:
      'Optional explicit user list. Omit to batch across every active employee.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  userIds?: number[];
}

/** Body shape for approve / reopen. The target user is a path param. */
export class ApproveMonthDto {
  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(2000)
  @Max(3000)
  @Type(() => Number)
  year!: number;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month!: number;
}
