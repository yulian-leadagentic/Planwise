import { IsOptional, IsEnum, IsInt, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { RelationshipTarget } from '@prisma/client';

export class QueryRelationshipsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sourcePartnerId?: number;

  @ApiPropertyOptional({ enum: RelationshipTarget })
  @IsOptional()
  @IsEnum(RelationshipTarget)
  targetType?: RelationshipTarget;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  targetId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  relationshipTypeCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;
}
