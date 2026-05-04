import { IsOptional, IsEnum, IsString, IsInt, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ProjectStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class QueryProjectsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  projectTypeId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isArchived?: boolean;

  /**
   * Filter to projects where the given user is either the leader OR an
   * active member. Used by the Projects list "Team member" filter — and
   * by the per-person workload tools that ask "what's on this person?".
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  memberId?: number;
}
