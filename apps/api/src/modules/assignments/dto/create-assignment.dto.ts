import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus, AssignmentPriority } from '@prisma/client';

export class CreateAssignmentDto {
  @ApiProperty()
  @IsInt()
  deliverableId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  zoneId?: number;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: AssignmentStatus })
  @IsOptional()
  @IsEnum(AssignmentStatus)
  status?: AssignmentStatus;

  @ApiPropertyOptional({ enum: AssignmentPriority })
  @IsOptional()
  @IsEnum(AssignmentPriority)
  priority?: AssignmentPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  budgetHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  budgetAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
