import { IsEnum, IsOptional, IsString, IsEmail, MaxLength, ValidateIf, IsArray, IsInt } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PartnerType, PartnerSource } from '@prisma/client';

export class CreateBusinessPartnerDto {
  @ApiProperty({ enum: PartnerType })
  @IsEnum(PartnerType)
  partnerType: PartnerType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  // Person fields
  @ApiPropertyOptional()
  @ValidateIf((o) => o.partnerType === 'person')
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.partnerType === 'person')
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  // Org fields
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  companyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  mobile?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @ApiPropertyOptional({ enum: PartnerSource })
  @IsOptional()
  @IsEnum(PartnerSource)
  source?: PartnerSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  /** Optional initial role-type IDs to attach. */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  initialRoleTypeIds?: number[];
}
