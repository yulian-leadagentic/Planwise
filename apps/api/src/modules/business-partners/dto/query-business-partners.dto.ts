import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsString, IsInt, Min, IsBoolean } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PartnerType } from '@prisma/client';

export class QueryBusinessPartnersDto {
  @ApiPropertyOptional({ enum: PartnerType })
  @IsOptional()
  @IsEnum(PartnerType)
  partnerType?: PartnerType;

  /** Filter by role type code (e.g. 'employee', 'customer'). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roleType?: string;

  /**
   * Restrict to persons whose active `worker_of` relationship targets
   * the given organization id. Server-side so the Contacts page's
   * "Filter by employer" reaches ALL matches instead of only the
   * currently-loaded page (bug fixed 2026-08-05 in ux/contacts).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employerId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  /** Free-text search across display_name, email, company_name, phone. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage?: number = 50;

  /**
   * When true, each returned partner is enriched with the projects they
   * touch — either directly (project_partner_roles.party_id = bp.id) or
   * indirectly via their worker_of employer being the project's customer.
   * Adds two passes after the main query; opt-in so the cheap callers
   * (e.g. relationship pickers) aren't slowed down.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  withProjects?: boolean;

  /**
   * QA3 Commit D (Item 6b) — By-Customer UNION.
   * When true AND `roleType` is set (e.g. 'customer'), the WHERE unions
   * matches on the businessPartnerRole tag with matches on
   * ProjectPartnerRole where role.code equals `roleType`. Fixes the
   * "orgs used as project customers but never tagged" gap — e.g. legacy
   * data from before the create-project guard existed. The intersection
   * of the two sets is the pre-existing behaviour; the union adds the
   * orgs that were only recorded via project participation.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeProjectCustomers?: boolean;

  /**
   * QA3 Commit D (Item 5) — customer-contact candidates must NOT surface
   * internal staff. Two rules combined:
   *   - the person has a login user account (User row) — they're internal;
   *   - the person's active `worker_of` targets an org whose displayName
   *     or companyName is "Internal" (the seeded self-org).
   * Enforced on the server so the Contacts / candidate flows can't drift
   * from what the UI-side filter does.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  excludeInternal?: boolean;
}
