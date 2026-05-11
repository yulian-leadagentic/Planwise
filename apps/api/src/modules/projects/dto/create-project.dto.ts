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
