import { IsOptional, IsEnum, IsString, IsInt, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryTasksDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  zoneId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  serviceTypeId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  phaseId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assigneeId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  /**
   * Show ONLY soft-deleted ("archived") tasks. Default false — the
   * normal list excludes archived rows. The Archived view on /tasks
   * passes `?archived=true` to get the inverse.
   */
  @ApiPropertyOptional({ description: 'Show only archived (soft-deleted) tasks' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  archived?: boolean;

  /**
   * Personal-task filter (client feedback 2026-08-02). Tri-state so
   * reports can request "hide personal", "only personal", or "both"
   * (the default). Applied server-side alongside the other filters.
   *   • `include` (default) — return every task
   *   • `exclude` — return only project/process tasks
   *   • `only` — return only personal tasks
   */
  @ApiPropertyOptional({ description: 'Personal-task filter: include|exclude|only', enum: ['include', 'exclude', 'only'] })
  @IsOptional()
  @IsEnum(['include', 'exclude', 'only'] as const)
  personal?: 'include' | 'exclude' | 'only';
}
