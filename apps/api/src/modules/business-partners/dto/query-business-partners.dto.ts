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
   * Exclude employees from the returned set (D1 rule).
   *
   * People UX M6 (P-03, 2026-09-27) — the D1 rule replaced the pre-M6
   * "displayName is Internal" string match. An employee is now defined
   * as a person BP with a User row whose `email` domain is owned by
   * the AMEC home org (see `BusinessPartner.isHomeOrg`). When the
   * home org is unresolved, the filter degrades to "user IS NULL" as
   * a safe default — no authenticated identities leak into external-
   * facing pickers.
   *
   * Used by:
   *   - Contacts page ("Include AMEC employees" toggle OFF).
   *   - Customer-contact and role-assignment pickers that intentionally
   *     hide internal staff.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  excludeInternal?: boolean;
}
