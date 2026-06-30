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

  /**
   * Include CLOSED projects in the result set. By default the list
   * returns only `closedAt IS NULL` rows — the Project list page exposes
   * a "Show closed" toggle that flips this flag. Audit / historical
   * tools that need every project pass it as true. (T3.6+7, 2026-06-28)
   */
  @ApiPropertyOptional({ description: 'Pass true to include closed projects (default: false)' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeClosed?: boolean;

  /**
   * Filter to ONLY closed projects (the inverse of the default filter).
   * Used when the user picks "Closed" in the project-list status dropdown:
   * the dropdown sends `closedOnly=true` and we restrict the result set to
   * `closedAt IS NOT NULL`. Implicitly disables the default
   * `closedAt = null` filter — `closedOnly` and `includeClosed` are both
   * scoped to the same column. (T3.6 follow-up, 2026-06-29.)
   */
  @ApiPropertyOptional({ description: 'Pass true to show ONLY closed projects' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  closedOnly?: boolean;
}
