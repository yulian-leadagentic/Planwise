import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * HR Phase B3 (2026-10-15) — payload for POST
 * /hr/employees/:id/absences. The service special-cases
 * `bereavement_1st_degree`: when `dateTo` is omitted (or equals
 * `dateFrom`), it auto-sets `dateTo = dateFrom + 6 days` per spec §3.4
 * (7 contiguous calendar days). The engine still stores a single
 * absence row — the span is encoded in dateFrom/dateTo.
 */
export class CreateAbsenceRecordDto {
  @ApiProperty()
  @IsInt()
  @Type(() => Number)
  absenceTypeId: number;

  @ApiProperty({ description: 'ISO date — yyyy-mm-dd.' })
  @IsDateString()
  dateFrom: string;

  @ApiPropertyOptional({
    description: 'ISO date — yyyy-mm-dd. Omit for single-day absences (service treats missing dateTo = dateFrom).',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiProperty({ description: 'Units consumed (days or hours per the absence type).' })
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @ApiPropertyOptional({ description: 'Attachment id from POST /hr/employees/:id/attachments.' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  documentFileId?: number | null;

  @ApiPropertyOptional({ description: 'Free-text note (max 500 chars).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateAbsenceRecordDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  absenceTypeId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  documentFileId?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
