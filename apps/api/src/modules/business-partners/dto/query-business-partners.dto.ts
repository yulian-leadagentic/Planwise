import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
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
}
