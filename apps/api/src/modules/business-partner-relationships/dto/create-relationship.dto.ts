import { IsIn, IsInt, IsOptional, IsString, IsBoolean, IsDateString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

// BM2 Phase 1 (2026-08-13): the `RelationshipTarget` enum from
// `@prisma/client` was retired with the legacy
// `business_partner_relationships` table. The compat endpoint still
// accepts the same shape, but only routes `organization` (→
// partner_relationships) and `project` (→ project_partner_roles);
// `department` and `team` are rejected with 400.
export type BprTargetType = 'organization' | 'project' | 'department' | 'team';

export class CreateRelationshipDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  sourcePartnerId: number;

  @ApiProperty({ enum: ['organization', 'project', 'department', 'team'] })
  @IsIn(['organization', 'project', 'department', 'team'])
  targetType: BprTargetType;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  targetId: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  relationshipTypeId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  roleInContext?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  validTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
