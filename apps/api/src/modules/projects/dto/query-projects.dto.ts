import { IsOptional, IsEnum, IsString, IsInt, IsBoolean, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
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
   *
   * DEPRECATED (fix/people-filter, 2026-08-25). The single-value form
   * only walked `projectMember.userId` and `leaderId`, which missed the
   * BIM Manager / BIM Coordinator / other ProjectPartnerRole holders
   * whose team membership lives on the party↔project edge (Alex Isakov
   * on 3 projects, filter returned 2). Keep as a backwards-compat
   * alias — the service maps `memberId` → `memberIds=[memberId]` so
   * existing callers keep working.
   */
  @ApiPropertyOptional({ description: 'DEPRECATED — use memberIds[] instead. Kept as an alias.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  memberId?: number;

  /**
   * Filter to projects where ANY of the given users is on the project
   * via ANY of the paths we consider "on the team":
   *   • project.leaderId
   *   • ProjectMember row (legacy internal-team join)
   *   • ProjectPartnerRole where the party is the person, OR
   *     the party is an org and the contactParty is the person
   * UNION semantics — matches the "OR" the user expects from a
   * multi-select filter chip stack. (fix/people-filter, 2026-08-25.)
   *
   * Query-string shape accepts both repeated `memberIds=1&memberIds=2`
   * and comma-joined `memberIds=1,2` — the Transform below normalizes
   * both to `number[]` and drops NaN.
   */
  @ApiPropertyOptional({
    type: [Number],
    description: 'UNION filter across leader / legacy member / project-partner-role paths.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const raw: unknown[] = Array.isArray(value) ? value : String(value).split(',');
    const nums = raw
      .map((v) => (typeof v === 'number' ? v : parseInt(String(v).trim(), 10)))
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length ? nums : undefined;
  })
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[];

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
