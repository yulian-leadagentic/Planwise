import { IsEnum, IsInt, IsOptional, IsString, IsBoolean, IsDateString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { RelationshipTarget } from '@prisma/client';

export class CreateRelationshipDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  sourcePartnerId: number;

  @ApiProperty({ enum: RelationshipTarget })
  @IsEnum(RelationshipTarget)
  targetType: RelationshipTarget;

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
