import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HR Phase B3 (2026-10-15) — payload for PATCH /hr/settings. Each
 * field is optional; omitted keys preserve the stored value. All
 * three knobs are strict `> 0 && <= 24` per Yulian's Q&A.
 */
export class UpdateHrSettingsDto {
  @ApiPropertyOptional({ description: 'Short-day hours on holiday eve.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(24)
  @Type(() => Number)
  shortDayHoursHolidayEve?: number;

  @ApiPropertyOptional({ description: 'Short-day hours on chol-hamoed.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(24)
  @Type(() => Number)
  shortDayHoursCholHamoed?: number;

  @ApiPropertyOptional({ description: 'Minimum hours per working day.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(24)
  @Type(() => Number)
  minHoursPerDay?: number;
}
