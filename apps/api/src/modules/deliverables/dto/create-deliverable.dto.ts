import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliverableScope } from '@prisma/client';

export class CreateDeliverableDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  percentage?: number;

  @ApiPropertyOptional({ enum: DeliverableScope, default: DeliverableScope.per_zone })
  @IsOptional()
  @IsEnum(DeliverableScope)
  scope?: DeliverableScope;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  budgetHours?: number;
}
