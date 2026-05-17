import { IsOptional, IsString, IsDateString, IsInt } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class ReportQueryDto {
  @ApiPropertyOptional({ description: 'Start date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  groupBy?: string;

  // The /reports/export endpoint takes the report key and the file
  // format alongside the standard report filters. They live here on
  // the DTO so the global ValidationPipe (forbidNonWhitelisted) doesn't
  // reject the request — previously calling /export with these in the
  // query string returned 400 "property type/format should not exist".
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ enum: ['excel', 'pdf'] })
  @IsOptional()
  @IsString()
  format?: string;
}
