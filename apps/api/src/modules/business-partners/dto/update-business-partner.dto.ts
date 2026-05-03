import { PartialType } from '@nestjs/mapped-types';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { CreateBusinessPartnerDto } from './create-business-partner.dto';

export class UpdateBusinessPartnerDto extends PartialType(CreateBusinessPartnerDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string; // active | inactive
}
