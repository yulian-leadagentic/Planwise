import { IsString, IsOptional, IsInt, IsEnum, IsNumber, IsDateString, IsArray, IsBoolean, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ProjectStatus } from '@prisma/client';

/**
 * One role assignment supplied at project-create time. Used to satisfy
 * ProjectRoleType.isPrimaryRequired roles (e.g. "Project Lead" if the
 * admin flagged it required). Creates a project_partner_role row.
 */
export class ProjectRoleAssignmentDto {
  @IsInt()
  @Type(() => Number)
  roleId: number;

  @IsInt()
  @Type(() => Number)
  partyId: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  titleInProject?: string;
}

export class CreateProjectDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsInt()
  projectTypeId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  departmentId?: number;

  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  budget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  estimatedValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Project leader user ID' })
  @IsOptional()
  @IsInt()
  leaderId?: number;

  @ApiPropertyOptional({ description: 'Initial team member user IDs', type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  memberIds?: number[];

  // ─── Project Info fields ──────────────────────────────────────────
  // Free-text descriptors surfaced on the Project Info tab. All
  // optional; create flows generally leave them blank and the user
  // fills them in once the project is set up.

  @ApiPropertyOptional({ description: 'Free-text authoring tool version (e.g. "Revit 2024.2")' })
  @IsOptional()
  @IsString()
  authoringToolVersion?: string;

  @ApiPropertyOptional({ description: 'Day/time of weekly project meeting (free text)' })
  @IsOptional()
  @IsString()
  weeklyMeetingDay?: string;

  @ApiPropertyOptional({ description: 'File-management system + hub link (free text / URL)' })
  @IsOptional()
  @IsString()
  fileSystemLink?: string;

  @ApiPropertyOptional({ description: 'Free-text summary of services we deliver per the contract' })
  @IsOptional()
  @IsString()
  servicesPerContract?: string;

  /**
   * Per-project Deliverable display-name overrides, keyed by template id
   * → custom label. Populated from the inline rename UI on planning-grid
   * deliverable headers (A14b). Stored as JSON on Project. Whitelisted
   * here so PATCH /projects/:id can persist the map; without this entry
   * NestJS ValidationPipe rejects the property and the rename mutation
   * fails with "property deliverableNameOverrides should not exist"
   * (X1 in the bug list).
   */
  @ApiPropertyOptional({
    description: 'Per-template display-name overrides ({ [templateId]: name })',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  deliverableNameOverrides?: Record<string, string>;

  /**
   * Required: the BusinessPartner id of the customer organization this
   * project belongs to. Must be an organization holding the "customer"
   * role. Use the seeded "Internal" org (partner_type=organization,
   * company_name=Internal) for internal projects with no external
   * customer.
   */
  @ApiProperty({ description: 'Customer organization BusinessPartner id (required)' })
  @IsInt()
  @Type(() => Number)
  customerOrgId: number;

  /**
   * Optional list of project-role assignments wired at create time. The
   * service validates that every ProjectRoleType with isPrimaryRequired=true
   * (excluding 'customer', which is handled via customerOrgId) has at least
   * one entry here with isPrimary=true.
   */
  @ApiPropertyOptional({ type: [ProjectRoleAssignmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProjectRoleAssignmentDto)
  roleAssignments?: ProjectRoleAssignmentDto[];
}
