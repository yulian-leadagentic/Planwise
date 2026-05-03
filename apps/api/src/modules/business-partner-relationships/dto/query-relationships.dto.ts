import { IsOptional, IsEnum, IsInt, IsString, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
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

  /** Default true — only return rows where now() is between validFrom and validTo. Set ?activeOnly=false to include history. */
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === undefined ? undefined : !(value === false || value === 'false' || value === '0'))
  activeOnly?: boolean;
}
