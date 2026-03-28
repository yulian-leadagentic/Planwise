import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClockType } from '@prisma/client';

export class ClockInDto {
  @ApiPropertyOptional({ enum: ClockType })
  @IsOptional()
  @IsEnum(ClockType)
  clockType?: ClockType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}
