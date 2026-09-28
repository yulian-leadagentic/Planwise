import { IsString, IsOptional, IsInt, IsEnum, IsNumber, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContractStatus } from '@prisma/client';

export class CreateContractDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  projectId?: number;

  /**
   * Phase 4 · Stage 3 (2026-09-28) — LEGACY. `partnerId` is a User FK
   * kept for backward compatibility. New callers should send `partyId`
   * (BusinessPartner FK) instead; both are accepted for one release.
   */
  @ApiPropertyOptional({ description: 'LEGACY — User FK; prefer `partyId`' })
  @IsOptional()
  @IsInt()
  partnerId?: number;

  /**
   * Phase 4 · Stage 3 (2026-09-28) — the BusinessPartner this contract
   * is with (org or person). Preferred over the legacy `partnerId`
   * (User FK). When both are given, `partyId` wins.
   */
  @ApiPropertyOptional({ description: 'BusinessPartner FK — org or person' })
  @IsOptional()
  @IsInt()
  partyId?: number;

  @ApiPropertyOptional({ enum: ContractStatus })
  @IsOptional()
  @IsEnum(ContractStatus)
  status?: ContractStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  totalAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
