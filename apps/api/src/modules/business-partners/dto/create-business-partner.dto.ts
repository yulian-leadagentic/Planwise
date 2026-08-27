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

  /** Optional Hebrew rendering — bilingual search matches both languages.
   *  T3.3, 2026-06-28. */
  @ApiPropertyOptional()
  @ValidateIf((o) => o.partnerType === 'person')
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstNameHe?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.partnerType === 'person')
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastNameHe?: string;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  linkedinUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  facebookUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  twitterUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instagramUrl?: string;

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

  /**
   * Main Role — the contact's primary categorization (Customer / Supplier /
   * Consultant / Internal / ...). Optional; if absent, drawer surfaces a
   * soft prompt. Validated FK by Prisma at insert time.
   */
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  mainRoleTypeId?: number | null;

  /**
   * Discipline — BM2 QA-2 Commit 4 (2026-08-27). Managed lookup on
   * `disciplines`. INFORMATIONAL only; the eligibility check on
   * `project_partner_roles` does NOT read this. Optional; validated FK
   * by Prisma at insert time.
   */
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  disciplineId?: number | null;
}
